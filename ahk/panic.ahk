#Requires AutoHotkey v2.0
#SingleInstance Force
#NoTrayIcon
; Not-Aus: Hotkey beendet dieses Skript mit Code 42, der Server erkennt das.
Hotkey A_Args[1], (*) => ExitApp(42)
; Session Stats: optionaler zweiter Hotkey zählt einen Fail. Meldet sich
; über die Standardausgabe ("fail"), das Skript läuft dabei weiter.
if (A_Args.Length >= 2 && A_Args[2] != "")
    Hotkey A_Args[2], (*) => FileAppend("fail`n", "*")
Persistent
