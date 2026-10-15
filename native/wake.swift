// Detecção de "Jarvis" com o reconhecimento de fala da Apple, 100% no Mac
// (requiresOnDeviceRecognition). Emite linhas JSON em stdout:
//   {"evento":"pronto"}                       escutando
//   {"evento":"wake"}                         ouviu "Jarvis"
//   {"evento":"comando","texto":"que horas são"}  o que veio depois (pode ser vazio)
//   {"evento":"erro","mensagem":"…"}
// Lê comandos em stdin: "pausar", "retomar". Fecha quando o stdin fecha.

import AVFoundation
import Foundation
import Speech

func emitLine(_ object: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
    data.append(0x0A)
    FileHandle.standardOutput.write(data)
}

// Todo o estado é tocado só na fila principal (callbacks redirecionados para ela).
final class WakeListener: @unchecked Sendable {
    private let recognizer: SFSpeechRecognizer
    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var generation = 0
    private var running = false
    private var armed = false        // ouviu "Jarvis", coletando o comando
    private var command = ""
    private var silence: DispatchWorkItem?
    private var recycle: DispatchWorkItem?
    private var armedDeadline: DispatchWorkItem?

    // Variações de como o reconhecimento em português escreve "Jarvis".
    private let wake = try! NSRegularExpression(
        pattern: "\\b(jarvis|jarvi|jarbas|javis|jarves|jarvas|jervis|djarvis|garvis|jarviz|járvis)\\b[,.!?]*",
        options: [.caseInsensitive]
    )

    init?() {
        guard let r = SFSpeechRecognizer(locale: Locale(identifier: "pt-BR")), r.supportsOnDeviceRecognition else {
            return nil
        }
        recognizer = r
    }

    func start() {
        guard !running else { return }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else {
            emitLine(["evento": "erro", "mensagem": "Nenhum microfone disponível."])
            return
        }
        // installTap(onBus:…:block:) está obsoleta no macOS 27, mas a substituta com erro
        // ainda não tem forma Swift no SDK das Command Line Tools; esta segue suportada.
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            self.lock.lock()
            self.request?.append(buffer)
            self.lock.unlock()
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            emitLine(["evento": "erro", "mensagem": "Não consegui abrir o microfone: \(error.localizedDescription)"])
            return
        }
        running = true
        newTask()
        emitLine(["evento": "pronto"])
    }

    func stop() {
        guard running else { return }
        // Pausado no meio de um comando: entrega o que já ouviu em vez de descartar.
        if armed { finishCommand(restart: false) }
        running = false
        armed = false
        [silence, recycle, armedDeadline].forEach { $0?.cancel() }
        endTask()
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        emitLine(["evento": "pausado"])
    }

    private func endTask() {
        task?.cancel()
        task = nil
        lock.lock()
        request?.endAudio()
        request = nil
        lock.unlock()
    }

    private func newTask() {
        endTask()
        guard running else { return }
        generation += 1
        let gen = generation
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = true  // o áudio nunca sai do Mac
        req.contextualStrings = ["Jarvis", "Ei Jarvis", "Ok Jarvis"]
        req.taskHint = .dictation
        req.addsPunctuation = false
        lock.lock()
        request = req
        lock.unlock()
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            DispatchQueue.main.async {
                self?.handle(gen: gen, text: text, isFinal: isFinal, failed: error != nil)
            }
        }
        // Recicla a transcrição de tempos em tempos para ela não crescer sem fim.
        recycle?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self, self.running, !self.armed else { return }
            self.newTask()
        }
        recycle = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 40, execute: item)
    }

    private func lastWake(in text: String) -> Range<String.Index>? {
        let all = wake.matches(in: text, range: NSRange(text.startIndex..., in: text))
        guard let last = all.last else { return nil }
        return Range(last.range, in: text)
    }

    private func handle(gen: Int, text: String?, isFinal: Bool, failed: Bool) {
        guard gen == generation, running else { return }
        if let text {
            if let range = lastWake(in: text) {
                if !armed {
                    armed = true
                    emitLine(["evento": "wake"])
                    // Se a pessoa não falar mais nada, encerra a escuta do comando em até 8 s.
                    let deadline = DispatchWorkItem { [weak self] in self?.finishCommand() }
                    armedDeadline = deadline
                    DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: deadline)
                }
                command = String(text[range.upperBound...])
                waitForSilence()
            } else if armed {
                waitForSilence()
            }
        }
        if isFinal || failed {
            if armed { finishCommand() } else { scheduleRestart(failed: failed) }
        }
    }

    private func waitForSilence() {
        silence?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.finishCommand() }
        silence = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.3, execute: item)
    }

    private func finishCommand(restart: Bool = true) {
        guard armed else { return }
        armed = false
        [silence, armedDeadline].forEach { $0?.cancel() }
        let text = command.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters))
        command = ""
        emitLine(["evento": "comando", "texto": text])
        if restart { newTask() }
    }

    private func scheduleRestart(failed: Bool) {
        DispatchQueue.main.asyncAfter(deadline: .now() + (failed ? 1 : 0.1)) { [weak self] in
            guard let self, self.running else { return }
            self.newTask()
        }
    }
}

func requestMicrophone() async -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return true
    case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
    default: return false
    }
}

func requestSpeech() async -> Bool {
    await withCheckedContinuation { cont in
        SFSpeechRecognizer.requestAuthorization { cont.resume(returning: $0 == .authorized) }
    }
}

func runWakeListener() async -> Never {
    guard let listener = WakeListener() else {
        emitLine(["evento": "erro", "mensagem": "Reconhecimento de português no Mac indisponível. Ative o Ditado em Ajustes do Sistema → Teclado."])
        exit(1)
    }
    guard await requestMicrophone() else {
        emitLine(["evento": "erro", "codigo": "sem_microfone", "mensagem": "Sem acesso ao microfone. Libere o Jarvis em Ajustes do Sistema → Privacidade e Segurança → Microfone."])
        exit(1)
    }
    guard await requestSpeech() else {
        emitLine(["evento": "erro", "codigo": "sem_fala", "mensagem": "Sem permissão de Reconhecimento de Fala. Libere o Jarvis em Ajustes do Sistema → Privacidade e Segurança → Reconhecimento de Fala."])
        exit(1)
    }

    // Comandos do app pelo stdin. Stdin fechado = o app saiu: encerra junto.
    FileHandle.standardInput.readabilityHandler = { handle in
        let data = handle.availableData
        if data.isEmpty { exit(0) }
        let lines = String(decoding: data, as: UTF8.self).split(whereSeparator: \.isNewline)
        DispatchQueue.main.async {
            for line in lines {
                switch line.trimmingCharacters(in: .whitespaces) {
                case "pausar": listener.stop()
                case "retomar": listener.start()
                default: break
                }
            }
        }
    }

    await MainActor.run { listener.start() }
    while true { try? await Task.sleep(nanoseconds: 3_600_000_000_000) }
}
