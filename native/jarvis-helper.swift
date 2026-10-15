// jarvis-helper — acesso ao Calendário e aos Lembretes do macOS via EventKit.
// Uso: jarvis-helper <comando> '<json>'
// Responde sempre um JSON em stdout. Compilar: npm run helper

import EventKit
import Foundation

let store = EKEventStore()
let tz = TimeZone.current
var cal = Calendar.current

// MARK: - Datas

func formatter(_ format: String) -> DateFormatter {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = tz
    f.dateFormat = format
    return f
}

let outFormat = formatter("yyyy-MM-dd'T'HH:mm")
let dayFormat = formatter("yyyy-MM-dd")
let inFormats = ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd HH:mm", "yyyy-MM-dd"].map(formatter)

func parseDate(_ value: Any?) -> Date? {
    guard let s = (value as? String)?.trimmingCharacters(in: .whitespaces), !s.isEmpty else { return nil }
    let iso = ISO8601DateFormatter()
    if let d = iso.date(from: s) { return d }  // com fuso, ex.: 2026-10-14T15:00:00-03:00
    for f in inFormats { if let d = f.date(from: s) { return d } }
    return nil
}

func isDateOnly(_ value: Any?) -> Bool {
    guard let s = value as? String else { return false }
    return s.count == 10
}

func out(_ date: Date?) -> Any { date.map { outFormat.string(from: $0) } ?? NSNull() }

// MARK: - Saída

func emit(_ object: Any) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    exit(0)
}

func fail(_ code: String, _ message: String) -> Never {
    emit(["erro": code, "mensagem": message])
}

// MARK: - Permissões

func statusName(_ s: EKAuthorizationStatus) -> String {
    switch s {
    case .fullAccess: return "permitido"
    case .writeOnly: return "so_escrita"
    case .denied: return "negado"
    case .restricted: return "restrito"
    case .notDetermined: return "nao_perguntado"
    @unknown default: return "desconhecido"
    }
}

func ensureAccess(_ type: EKEntityType) async {
    let status = EKEventStore.authorizationStatus(for: type)
    if status == .fullAccess { return }
    let what = type == .event ? "Calendário" : "Lembretes"
    if status == .notDetermined {
        let granted = (try? await (type == .event ? store.requestFullAccessToEvents() : store.requestFullAccessToReminders())) ?? false
        if granted { return }
    }
    fail("sem_permissao", "Sem acesso a \(what). Libere em Ajustes do Sistema → Privacidade e Segurança → \(what).")
}

// MARK: - Comandos

func eventJSON(_ e: EKEvent) -> [String: Any] {
    var o: [String: Any] = [
        "titulo": e.title ?? "(sem título)",
        "inicio": out(e.startDate),
        "fim": out(e.endDate),
        "dia_inteiro": e.isAllDay,
        "calendario": e.calendar?.title ?? "",
    ]
    if let l = e.location, !l.isEmpty { o["local"] = l }
    if let n = e.notes, !n.isEmpty { o["notas"] = String(n.prefix(300)) }
    if let att = e.attendees, !att.isEmpty { o["participantes"] = att.count }
    return o
}

func reminderJSON(_ r: EKReminder) -> [String: Any] {
    var o: [String: Any] = ["titulo": r.title ?? "(sem título)", "lista": r.calendar?.title ?? ""]
    if let comps = r.dueDateComponents, let d = cal.date(from: comps) {
        o["vencimento"] = comps.hour == nil ? dayFormat.string(from: d) : outFormat.string(from: d)
        o["atrasado"] = d < Date()
    }
    if r.priority > 0 { o["prioridade"] = r.priority <= 4 ? "alta" : r.priority == 5 ? "média" : "baixa" }
    if let n = r.notes, !n.isEmpty { o["notas"] = String(n.prefix(300)) }
    return o
}

func fetchReminders(_ predicate: NSPredicate) async -> [EKReminder] {
    await withCheckedContinuation { cont in
        store.fetchReminders(matching: predicate) { cont.resume(returning: $0 ?? []) }
    }
}

func fold(_ s: String) -> String {
    s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil).trimmingCharacters(in: .whitespaces)
}

func agenda(_ args: [String: Any]) async -> Never {
    await ensureAccess(.event)
    let start = parseDate(args["inicio"]) ?? cal.startOfDay(for: Date())
    var end = parseDate(args["fim"]) ?? cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: start))!
    if isDateOnly(args["fim"]) { end = cal.date(byAdding: .day, value: 1, to: end)! }  // fim inclusivo
    if end <= start { end = cal.date(byAdding: .day, value: 1, to: start)! }
    let events = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: nil))
        .sorted { $0.startDate < $1.startDate }
    emit([
        "de": out(start), "ate": out(end),
        "total": events.count,
        "eventos": events.prefix(60).map(eventJSON),
    ])
}

func lembretes(_ args: [String: Any]) async -> Never {
    await ensureAccess(.reminder)
    let until = parseDate(args["ate"])
    let all = await fetchReminders(store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil))
    let filtered = all.filter { r in
        guard let until else { return true }
        guard let comps = r.dueDateComponents, let d = cal.date(from: comps) else { return false }
        return d <= until
    }
    let sorted = filtered.sorted { a, b in
        let da = a.dueDateComponents.flatMap { cal.date(from: $0) } ?? .distantFuture
        let db = b.dueDateComponents.flatMap { cal.date(from: $0) } ?? .distantFuture
        return da < db
    }
    emit(["total": sorted.count, "lembretes": sorted.prefix(50).map(reminderJSON)])
}

func calendarNamed(_ name: Any?, for type: EKEntityType) -> EKCalendar? {
    guard let wanted = (name as? String).map(fold), !wanted.isEmpty else { return nil }
    return store.calendars(for: type).first { fold($0.title) == wanted && $0.allowsContentModifications }
}

func criarLembrete(_ args: [String: Any]) async -> Never {
    await ensureAccess(.reminder)
    guard let title = args["titulo"] as? String, !title.isEmpty else { fail("argumento", "Título vazio.") }
    let r = EKReminder(eventStore: store)
    r.title = title
    if let n = args["notas"] as? String { r.notes = n }
    guard let target = calendarNamed(args["lista"], for: .reminder) ?? store.defaultCalendarForNewReminders() else {
        fail("sem_lista", "Nenhuma lista de lembretes disponível.")
    }
    r.calendar = target
    if let when = parseDate(args["quando"]) {
        if isDateOnly(args["quando"]) {
            r.dueDateComponents = cal.dateComponents([.year, .month, .day], from: when)
        } else {
            r.dueDateComponents = cal.dateComponents([.year, .month, .day, .hour, .minute], from: when)
            r.addAlarm(EKAlarm(absoluteDate: when))
        }
    }
    do { try store.save(r, commit: true) } catch { fail("falha", error.localizedDescription) }
    emit(["ok": true, "lembrete": reminderJSON(r)])
}

func concluirLembrete(_ args: [String: Any]) async -> Never {
    await ensureAccess(.reminder)
    let wanted = fold(args["titulo"] as? String ?? "")
    guard !wanted.isEmpty else { fail("argumento", "Título vazio.") }
    let all = await fetchReminders(store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil))
    let exact = all.filter { fold($0.title ?? "") == wanted }
    let matches = exact.isEmpty ? all.filter { fold($0.title ?? "").contains(wanted) } : exact
    if matches.isEmpty { fail("nao_encontrado", "Nenhum lembrete pendente com esse nome.") }
    if matches.count > 1 { emit(["erro": "varios", "candidatos": matches.prefix(8).map(reminderJSON)]) }
    let r = matches[0]
    r.isCompleted = true
    do { try store.save(r, commit: true) } catch { fail("falha", error.localizedDescription) }
    emit(["ok": true, "concluido": r.title ?? ""])
}

func criarEvento(_ args: [String: Any]) async -> Never {
    await ensureAccess(.event)
    guard let title = args["titulo"] as? String, !title.isEmpty else { fail("argumento", "Título vazio.") }
    guard let start = parseDate(args["inicio"]) else { fail("argumento", "Início inválido. Use AAAA-MM-DDTHH:MM.") }
    let e = EKEvent(eventStore: store)
    e.title = title
    if isDateOnly(args["inicio"]) {
        e.isAllDay = true
        e.startDate = start
        e.endDate = start
    } else {
        e.startDate = start
        let minutes = (args["duracao_min"] as? Double) ?? 60
        e.endDate = parseDate(args["fim"]) ?? start.addingTimeInterval(minutes * 60)
    }
    if let l = args["local"] as? String { e.location = l }
    if let n = args["notas"] as? String { e.notes = n }
    guard let target = calendarNamed(args["calendario"], for: .event) ?? store.defaultCalendarForNewEvents else {
        fail("sem_calendario", "Nenhum calendário disponível para criar eventos.")
    }
    e.calendar = target
    e.addAlarm(EKAlarm(relativeOffset: -15 * 60))
    do { try store.save(e, span: .thisEvent, commit: true) } catch { fail("falha", error.localizedDescription) }
    emit(["ok": true, "evento": eventJSON(e)])
}

// MARK: - Entrada

@main
struct Helper {
    static func main() async {
        let argv = CommandLine.arguments
        guard argv.count >= 2 else { fail("uso", "jarvis-helper <comando> '<json>'") }
        var args: [String: Any] = [:]
        if argv.count >= 3, let data = argv[2].data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            args = parsed
        }
        switch argv[1] {
        case "status":
            emit([
                "calendario": statusName(EKEventStore.authorizationStatus(for: .event)),
                "lembretes": statusName(EKEventStore.authorizationStatus(for: .reminder)),
            ])
        case "agenda": await agenda(args)
        case "lembretes": await lembretes(args)
        case "criar_lembrete": await criarLembrete(args)
        case "concluir_lembrete": await concluirLembrete(args)
        case "criar_evento": await criarEvento(args)
        case "escutar": await runWakeListener()
        default: fail("uso", "Comando desconhecido: \(argv[1])")
        }
    }
}
