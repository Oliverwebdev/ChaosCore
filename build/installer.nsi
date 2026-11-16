; Installer (NSIS). Wird von build-win.mjs mit Definitionen aufgerufen:
;   APP_NAME APP_VERSION PUBLISHER WEBSITE EXE_NAME SRC_DIR OUT_FILE ASSETS NOTICE_FILE
Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"

Name "${APP_NAME}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "Software\${APP_NAME}" "InstallDir"
RequestExecutionLevel user          ; ohne Administrator-Rechte, nur für den aktuellen Benutzer
SetCompressor /SOLID lzma
BrandingText "${APP_NAME} ${APP_VERSION}"
ShowInstDetails nevershow
ShowUninstDetails nevershow

VIProductVersion "${APP_VERSION_4}"
VIAddVersionKey /LANG=1031 "ProductName" "${APP_NAME}"
VIAddVersionKey /LANG=1031 "CompanyName" "${PUBLISHER}"
VIAddVersionKey /LANG=1031 "FileDescription" "${APP_NAME} Installer"
VIAddVersionKey /LANG=1031 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1031 "LegalCopyright" "${PUBLISHER}"

!define MUI_ICON "${ASSETS}\icon.ico"
!define MUI_UNICON "${ASSETS}\icon.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "${ASSETS}\installer-header.bmp"
!define MUI_HEADERIMAGE_RIGHT
!define MUI_WELCOMEFINISHPAGE_BITMAP "${ASSETS}\installer-side.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${ASSETS}\installer-side.bmp"
!define MUI_ABORTWARNING

!define MUI_WELCOMEPAGE_TITLE "$(WELCOME_TITLE)"
!define MUI_WELCOMEPAGE_TEXT "$(WELCOME_TEXT)"
!define MUI_LICENSEPAGE_TEXT_TOP "$(LICENSE_TOP)"
!define MUI_FINISHPAGE_TITLE "$(FINISH_TITLE)"
!define MUI_FINISHPAGE_TEXT "$(FINISH_TEXT)"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE_NAME}"
!define MUI_FINISHPAGE_RUN_TEXT "$(FINISH_RUN_TEXT)"
!ifdef WEBSITE
  !define MUI_FINISHPAGE_LINK "${WEBSITE}"
  !define MUI_FINISHPAGE_LINK_LOCATION "${WEBSITE}"
!endif

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${NOTICE_FILE}"
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; ---------- Sprachen ----------
; Müssen laut NSIS-Konvention NACH den Seiten-Makros oben eingebunden werden, sonst füllt MUI
; seine eigenen Standardtexte (Knöpfe, Abbrechen-Dialog usw.) für keine der beiden Sprachen.
; MUI_LANGDLL_ALWAYSSHOW: immer fragen, auch wenn Windows selbst schon Deutsch eingestellt hat -
; bewusst als Frage, nicht als automatische Erkennung.
!define MUI_LANGDLL_ALWAYSSHOW
!insertmacro MUI_LANGUAGE "German"
!insertmacro MUI_LANGUAGE "English"

; ---------- Zweisprachige Texte (Deutsch/Englisch) ----------
; Erst jetzt möglich, weil LANG_GERMAN/LANG_ENGLISH erst durch die MUI_LANGUAGE-Zeilen oben
; entstehen. Die !define-Zeilen für die Seiten-Texte weiter oben verweisen per "$(NAME)" bewusst
; schon vorher darauf - das wird erst zur Laufzeit aufgelöst, die Reihenfolge spielt dafür keine
; Rolle, nur beim eigentlichen LangString-Befehl hier unten.
LangString SEC_MAIN_TITLE ${LANG_GERMAN} "!${APP_NAME} (erforderlich)"
LangString SEC_MAIN_TITLE ${LANG_ENGLISH} "!${APP_NAME} (required)"
LangString SEC_MAIN_DESC ${LANG_GERMAN} "Das Programm selbst (inklusive Node.js und AutoHotkey, nichts weiter nötig)."
LangString SEC_MAIN_DESC ${LANG_ENGLISH} "The program itself (Node.js and AutoHotkey included, nothing else needed)."
LangString SEC_DESKTOP_TITLE ${LANG_GERMAN} "Desktop-Verknüpfung"
LangString SEC_DESKTOP_TITLE ${LANG_ENGLISH} "Desktop shortcut"
LangString SEC_DESKTOP_DESC ${LANG_GERMAN} "Legt ein Icon auf dem Desktop an, mit dem du das Programm jederzeit startest."
LangString SEC_DESKTOP_DESC ${LANG_ENGLISH} "Adds a desktop icon you can use to start the program any time."
LangString WELCOME_TITLE ${LANG_GERMAN} "Willkommen bei ${APP_NAME}"
LangString WELCOME_TITLE ${LANG_ENGLISH} "Welcome to ${APP_NAME}"
LangString WELCOME_TEXT ${LANG_GERMAN} "Mit diesem Programm steuern deine Zuschauer per Twitch-Kanalpunkten das Gameplay.$\r$\n$\r$\nDie Installation dauert nur einen Moment. Du brauchst keine Administrator-Rechte.$\r$\n$\r$\nDie Einrichtung (Twitch-Anmeldung, CS2) machst du danach bequem in einem Fenster."
LangString WELCOME_TEXT ${LANG_ENGLISH} "With this program, your viewers control your gameplay using Twitch channel points.$\r$\n$\r$\nThe installation only takes a moment. No administrator rights needed.$\r$\n$\r$\nYou'll do the setup (Twitch login, CS2) afterwards in a comfortable window."
LangString LICENSE_TOP ${LANG_GERMAN} "Dieses Programm bringt freie Software anderer Hersteller mit."
LangString LICENSE_TOP ${LANG_ENGLISH} "This program bundles free software from other authors."
LangString FINISH_TITLE ${LANG_GERMAN} "Fertig!"
LangString FINISH_TITLE ${LANG_ENGLISH} "Done!"
LangString FINISH_TEXT ${LANG_GERMAN} "${APP_NAME} ist installiert.$\r$\n$\r$\nBeim ersten Start führt dich ein Assistent durch die Einrichtung."
LangString FINISH_TEXT ${LANG_ENGLISH} "${APP_NAME} is installed.$\r$\n$\r$\nA wizard will guide you through setup on first launch."
LangString FINISH_RUN_TEXT ${LANG_GERMAN} "${APP_NAME} jetzt starten"
LangString FINISH_RUN_TEXT ${LANG_ENGLISH} "Start ${APP_NAME} now"
LangString UNINST_KEEPDATA ${LANG_GERMAN} "Auch deine Einstellungen und den gespeicherten Twitch-Login löschen?$\r$\n$\r$\n(Wenn du das Programm später wieder installieren willst, wähle Nein.)"
LangString UNINST_KEEPDATA ${LANG_ENGLISH} "Also delete your settings and the saved Twitch login?$\r$\n$\r$\n(Choose No if you plan to reinstall the program later.)"
LangString UNINST_NOTE ${LANG_GERMAN} "Hinweis: Die Belohnungen auf deinem Twitch-Kanal und die CS2-Dateien (unknown_chat_control.cfg) bleiben bestehen. Du kannst sie von Hand löschen."
LangString UNINST_NOTE ${LANG_ENGLISH} "Note: the rewards on your Twitch channel and the CS2 files (unknown_chat_control.cfg) remain. You can delete them by hand."

Function .onInit
  !insertmacro MUI_LANGDLL_DISPLAY
FunctionEnd

; Schreibt "de"/"en" nach $INSTDIR\locale.txt, damit das Programm beim allerersten Start weiß,
; welche Sprache beim Installieren gewählt wurde (siehe src/server.js). $LANGUAGE ist die LCID,
; die die Sprachauswahl-Dialogbox (oben, MUI_LANGDLL_ALWAYSSHOW) gesetzt hat.
Function WriteLocaleMarker
  FileOpen $9 "$INSTDIR\locale.txt" w
  ${If} $LANGUAGE == ${LANG_ENGLISH}
    FileWrite $9 "en"
  ${Else}
    FileWrite $9 "de"
  ${EndIf}
  FileClose $9
FunctionEnd

Function un.onInit
  !insertmacro MUI_UNGETLANGUAGE
FunctionEnd

Function StopRunning
  ; Nur die eigene, umbenannte Laufzeit beenden (nie fremde node.exe-Prozesse)
  nsExec::Exec 'taskkill /F /IM ucc-node.exe'
  Pop $0
  Sleep 400
FunctionEnd

Section "$(SEC_MAIN_TITLE)" SecMain
  SectionIn RO
  SetShellVarContext current
  Call StopRunning
  SetOutPath "$INSTDIR"
  File /r "${SRC_DIR}\*.*"
  Call WriteLocaleMarker
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\${APP_NAME}" "InstallDir" "$INSTDIR"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}.lnk" "$INSTDIR\${EXE_NAME}" "" "$INSTDIR\${EXE_NAME}" 0
  ; Eintrag unter "Apps & Features"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "DisplayIcon" "$INSTDIR\${EXE_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "NoRepair" 1
SectionEnd

Section "$(SEC_DESKTOP_TITLE)" SecDesktop
  SetShellVarContext current
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${EXE_NAME}" "" "$INSTDIR\${EXE_NAME}" 0
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} "$(SEC_MAIN_DESC)"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "$(SEC_DESKTOP_DESC)"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  SetShellVarContext current
  nsExec::Exec 'taskkill /F /IM ucc-node.exe'
  Pop $0
  Sleep 400
  Delete "$SMPROGRAMS\${APP_NAME}.lnk"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMSTARTUP\${APP_NAME}.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"
  DeleteRegKey HKCU "Software\${APP_NAME}"
  IfSilent done
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$(UNINST_KEEPDATA)" IDNO keepdata
    RMDir /r "$APPDATA\${APP_NAME}"
  keepdata:
  MessageBox MB_OK|MB_ICONINFORMATION "$(UNINST_NOTE)"
  done:
SectionEnd
