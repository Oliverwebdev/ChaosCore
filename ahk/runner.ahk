#Requires AutoHotkey v2.0
#SingleInstance Off
#NoTrayIcon
; UNKNOWN CHAT CONTROL - Effekt-Runner
; Aufruf: runner.ahk <stepsFile> <stopFile> <windowExe> <needFocus 0|1> <maxMs> <sensitivity>
; Exit-Codes: 0 ok
;             3 Spiel beim Start nicht im Vordergrund (es wurde NICHTS gesendet)
;             4 ungültiger Befehl
;             5 Fokus WÄHREND des Effekts verloren: sofort abgebrochen, alles Gehaltene losgelassen.
;               Der Effekt hatte keine Wiederherstellungs-Tasten - es bleibt nichts offen.
;             6 wie 5, aber der Effekt hatte Wiederherstellungs-Tasten (oncleanup), die NICHT
;               gesendet wurden. Der Spielzustand (z. B. gesperrte Schusstaste) ist damit
;               möglicherweise nicht zurückgesetzt - die Bridge protokolliert das.
;
; Fokus-Schutz: Eingaben dürfen nur im
; Spielfenster landen. Bisher wurde der Fokus nur EINMAL beim Start geprüft - wechselte man während
; eines Effekts das Fenster, gingen alle weiteren Tasten ins andere Fenster. Jetzt:
;   1. Guard() direkt vor JEDER Eingabe, die etwas drückt oder bewegt.
;   2. Nach jedem "Taste runter" sofort noch einmal prüfen. Zwischen Prüfung und Eingabe bleibt
;      unter Windows immer ein winziges Zeitfenster (beides lässt sich nicht zu EINEM unteilbaren
;      Schritt machen); landet deshalb doch einmal ein "runter" im falschen Fenster, wird die Taste
;      im selben Augenblick wieder losgelassen und der Effekt abgebrochen.
;   3. Ein Zeitgeber (FocusWatch, alle 15 ms) erkennt den Fokusverlust auch mitten in Wartezeiten
;      und gehaltenen Tasten.
;
; Nach einem Fokusverlust sendet dieser Runner AUSSCHLIESSLICH
; Loslassen-Ereignisse für Eingaben, die er selbst gedrückt hält (Taste hoch, Maustaste hoch) und
; hebt seine Tastensperren auf. Er drückt KEINE Taste mehr - auch keine Wiederherstellungs-Taste,
; weder sofort noch später, weder im fremden noch im Spielfenster. "Loslassen" wird nie blockiert:
; eine Taste freizugeben ist in jedem Fenster sicher und nötig, weil der Tastenzustand für den
; ganzen Rechner gilt.
SetWorkingDir A_ScriptDir
stepsFile := A_Args[1]
stopFile  := A_Args[2]
exe       := A_Args[3]
needFocus := (A_Args[4] = "1")
maxMs     := Integer(A_Args[5])
sens      := A_Args.Length >= 6 ? Float(A_Args[6]) : 1.0
if sens <= 0
    sens := 1.0
started   := A_TickCount
held      := Map()
hotkeys   := []
cleanups  := []
finishing := false
mouseDown := false
InGame() => WinActive("ahk_exe " exe) != 0

if needFocus && !InGame()
    ExitApp 3
if needFocus {
    HotIfWinActive "ahk_exe " exe
    SetTimer FocusWatch, 15
}

Stopped() => FileExist(stopFile) || (A_TickCount - started > maxMs)

; Muss direkt vor jeder Eingabe aufgerufen werden, die etwas drückt oder bewegt. Kehrt nur zurück,
; wenn das Spiel im Vordergrund ist (oder keine Fokusprüfung gewünscht ist) - sonst bricht
; AbortFocus() den ganzen Lauf ab.
Guard() {
    if !needFocus
        return
    if finishing
        Exit ; ein Abbruch läuft bereits: dieser Programmfaden sendet nichts mehr
    if !InGame()
        AbortFocus()
}

FocusWatch() {
    if !finishing && !InGame()
        AbortFocus()
}

Wait(ms) {
    endAt := A_TickCount + ms
    while A_TickCount < endAt {
        if Stopped()
            return false
        Sleep Min(25, Max(1, endAt - A_TickCount))
    }
    return true
}

Noop(*) {
}

; Getauschte Taste: Ziel gedrückt halten und beim Loslassen oder Ende sauber freigeben
MakeSwap(a, b) {
    fn(*) {
        Guard()
        held[b] := true
        Send "{Blind}{" b " down}"
        Guard()
    }
    return fn
}
MakeSwapUp(a, b) {
    fn(*) {
        Send "{Blind}{" b " up}"
        if held.Has(b)
            held.Delete(b)
    }
    return fn
}

AddHotkey(name, fn) {
    try {
        Hotkey name, fn, "On"
        hotkeys.Push(name)
    }
}

BlockKey(k) {
    AddHotkey("$*" k, Noop)
    if !(k ~= "i)^Wheel")
        AddHotkey("$*" k " up", Noop)
}

Unblock() {
    for name in hotkeys {
        try Hotkey name, "Off"
    }
    hotkeys.Length := 0
}

Down(k) {
    Guard()
    held[k] := true
    Send "{" k " down}"
    Guard()
}
; Loslassen wird nie blockiert (siehe Kopf der Datei).
Up(k) {
    Send "{" k " up}"
    if held.Has(k)
        held.Delete(k)
}
Tap(k, ms := 50) {
    Down(k)
    Sleep ms
    Up(k)
}

; Grad -> Maus-Zähler (CS2: 0.022 Grad pro Zähler bei Sensitivity 1)
Counts(deg) {
    return Round(deg / (0.022 * sens))
}

Rel(dx, dy) {
    Guard()
    DllCall("mouse_event", "UInt", 0x0001, "Int", dx, "Int", dy, "UInt", 0, "UPtr", 0)
}

; Linksklick (Granate werfen): CS2 liest Maustasten über Raw Input, nicht über die normale
; Fenster-Nachrichtenwarteschlange. Send("{LButton down/up}") landet dort oft gar nicht erst,
; obwohl Tastatur-Tasten (Send("{Space down}") usw.) ganz normal funktionieren - deshalb werden
; Bewegungstasten zuverlässig erkannt, ein simulierter Klick aber nicht. Genau wie bei der
; Mausbewegung oben (Rel) wird darum mouse_event() direkt aufgerufen statt Send/Click - das
; erzeugt echte Eingaben auf Treiberebene, die auch Raw-Input-Spiele sehen.
MouseUp() {
    global mouseDown
    DllCall("mouse_event", "UInt", 0x0004, "Int", 0, "Int", 0, "UInt", 0, "UPtr", 0) ; MOUSEEVENTF_LEFTUP
    mouseDown := false
}
LClick(ms := 60) {
    global mouseDown
    Guard()
    mouseDown := true
    DllCall("mouse_event", "UInt", 0x0002, "Int", 0, "Int", 0, "UInt", 0, "UPtr", 0) ; MOUSEEVENTF_LEFTDOWN
    Guard()
    Sleep ms
    MouseUp()
}

; Alles freigeben, was dieser Lauf gedrückt hält oder gesperrt hat. Sendet ausschließlich
; "loslassen" - nie eine neue Eingabe.
ReleaseAll() {
    Unblock()
    for k, _ in held.Clone()
        Up(k)
    if mouseDown
        MouseUp()
}

; Fokus verloren: sofort abbrechen. Kehrt nie zurück (ExitApp).
; Sendet NUR Loslassen (ReleaseAll) - keine einzige neue Eingabe, auch keine Wiederherstellung.
AbortFocus() {
    global finishing
    if finishing
        return
    finishing := true
    SetTimer FocusWatch, 0
    ReleaseAll()
    ExitApp cleanups.Length ? 6 : 5
}

Finish(code := 0) {
    global finishing
    ; Reguläres Ende (fertig, Stopp-Datei, Zeitlimit). Ist das Spiel in diesem Moment nicht mehr vorn,
    ; gilt dasselbe wie bei jedem anderen Fokusverlust: nur loslassen, keine Wiederherstellungs-Taste.
    if needFocus && !finishing && !InGame()
        AbortFocus()
    finishing := true
    SetTimer FocusWatch, 0
    ReleaseAll()
    ; Stopp mit "defer" (Bridge, Fix 2026-11-15): Spieler ist im Menü/Chat/in der Konsole - dort
    ; würden die Wiederherstellungs-Tasten als Text verpuffen. Nicht senden, die Bridge holt sie nach.
    if cleanups.Length && FileExist(stopFile) {
        try {
            if Trim(FileRead(stopFile)) = "defer"
                ExitApp 7
        }
    }
    ; Wiederherstellungs-Tasten (oncleanup) gehören zum regulären Ende eines Effekts, solange das
    ; Spiel im Vordergrund ist. Vor JEDER einzelnen wird der Fokus erneut geprüft; ist er weg, endet
    ; der Lauf sofort mit Code 6 und sendet den Rest nicht.
    for k in cleanups {
        if needFocus && !InGame()
            ExitApp 6
        try {
            Send "{" k " down}"
            Sleep 50
            Send "{" k " up}"
        }
    }
    ExitApp code
}

for line in StrSplit(FileRead(stepsFile, "UTF-8"), "`n", "`r") {
    line := Trim(line)
    if line = ""
        continue
    p := StrSplit(line, " ")
    cmd := p[1]
    if Stopped()
        break
    switch cmd {
        case "press":
            Tap(p[2], p.Length >= 3 ? Integer(p[3]) : 50)
        case "up":
            Up(p[2])
        case "hold":
            Down(p[2])
            Wait(Integer(p[3]))
            Up(p[2])
        case "wait":
            Wait(Integer(p[2]))
        case "click":
            LClick(p.Length >= 2 ? Integer(p[2]) : 60)
        case "mouse":
            n := Max(1, Integer(p[4]))
            dx := Integer(p[2]), dy := Integer(p[3])
            loop n {
                Rel(Round(dx / n), Round(dy / n))
                Sleep Integer(p[5])
            }
        case "look":
            n := Max(1, Integer(p[4]))
            dx := Counts(Integer(p[2])), dy := Counts(Integer(p[3]))
            loop n {
                Rel(Round(dx / n), Round(dy / n))
                Sleep Integer(p[5])
            }
        case "release":
            loop p.Length - 1
                Send "{" p[A_Index + 1] " up}"
        case "block":
            loop p.Length - 1
                BlockKey(p[A_Index + 1])
        case "unblock":
            Unblock()
        case "swap":
            AddHotkey("$*" p[2], MakeSwap(p[2], p[3]))
            AddHotkey("$*" p[2] " up", MakeSwapUp(p[2], p[3]))
        case "oncleanup":
            cleanups.Push(p[3])
        case "until_stop":
            while !Stopped()
                Sleep 25
        ; Aufgeschobene Wiederherstellung (Bridge: deferRestore): warten, bis das Spiel wieder im
        ; Vordergrund ist, und erst DANN mit voller Fokusprüfung weitermachen. Wird nur mit
        ; needFocus=0 gestartet; ab hier gilt der normale Fokus-Schutz wie bei jedem Effekt.
        case "waitfocus":
            while !InGame() {
                if Stopped()
                    ExitApp 3
                Sleep 100
            }
            Sleep 300
            needFocus := true
            HotIfWinActive "ahk_exe " exe
            SetTimer FocusWatch, 15
        default:
            Finish(4)
    }
}
Finish(0)
