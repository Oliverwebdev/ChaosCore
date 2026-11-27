# Uploads einrichten: Google- und TikTok-App für ChaosCore

Damit Streamer in ChaosCore nur auf **„Verbinden“** klicken müssen, bringt ChaosCore eigene App-Daten
für Google (YouTube) und TikTok mit. Diese Apps legt der Herausgeber **einmal** an. Diese Anleitung
führt Schritt für Schritt durch beide Portale. Wer lieber seine **eigene** App nutzt, macht dieselben
Schritte und trägt die Daten im Dashboard unter *Einstellungen → System → Eigene App-Daten (Entwickler)* ein.

> Ein Client Secret ist ein Zugangsschlüssel. Nicht in Chats, Screenshots oder Issues posten.
> Das TikTok-Secret gehört **nicht** ins öffentliche Repo, sondern in die GitHub-Secrets (Schritt 3).

---

## 1. Google / YouTube

### 1.1 Projekt anlegen
1. <https://console.cloud.google.com/> öffnen und mit dem Google-Konto anmelden, das die App besitzen soll.
2. Oben links auf die Projektauswahl → **Neues Projekt** → Name z. B. `ChaosCore` → **Erstellen**.
3. Das neue Projekt oben auswählen.

### 1.2 YouTube-Schnittstelle einschalten
1. Menü → **APIs & Dienste → Bibliothek**.
2. Nach **YouTube Data API v3** suchen → **Aktivieren**.

### 1.3 Zustimmungsbildschirm (OAuth consent screen)
1. Menü → **APIs & Dienste → OAuth-Zustimmungsbildschirm** (heißt in neueren Konsolen *Google Auth Platform → Branding*).
2. Nutzertyp **Extern** → App-Name `ChaosCore`, Support-E-Mail, Kontakt-E-Mail.
3. **Datenzugriff / Bereiche:** `https://www.googleapis.com/auth/youtube.upload` hinzufügen (nur dieser eine).
4. **Zielgruppe:** Solange die App im Status **„Testen“** ist, können sich nur eingetragene
   **Testnutzer** anmelden (bis zu 100), und Google lässt die Anmeldung nach **7 Tagen** ablaufen —
   ChaosCore meldet dann „bitte neu verbinden“. Für den Anfang: das eigene Google-Konto als Testnutzer eintragen.
5. Für alle Streamer: **App veröffentlichen** („In Produktion“). Weil `youtube.upload` ein sensibler
   Bereich ist, verlangt Google dafür eine **Prüfung** (Datenschutzerklärung und Startseite unter
   eigener Domain, kurzes Video, das den Ablauf zeigt). Bis dahin bleibt es beim Teststatus.

### 1.4 Zugangsdaten (Desktop-App)
1. Menü → **APIs & Dienste → Anmeldedaten → Anmeldedaten erstellen → OAuth-Client-ID**.
2. Anwendungstyp **Desktop-App**, Name `ChaosCore Desktop` → **Erstellen**.
3. **Client-ID** und **Clientschlüssel** notieren. Eine Weiterleitungs-Adresse muss man bei
   Desktop-Apps nicht eintragen — ChaosCore nutzt automatisch `http://127.0.0.1:<Port>/`.

### 1.5 Was YouTube noch wissen sollte
- Videos, die über eine **nicht geprüfte** App hochgeladen werden, setzt YouTube auf **privat**.
  Für öffentliche Uploads braucht das Projekt zusätzlich die **YouTube-API-Prüfung (Audit)**
  (Formular „YouTube API Services – Audit and Quota Extension“). Darum ist „privat“ in ChaosCore Standard.
- Kontingent: Uploads haben bei Google einen eigenen Topf, Standard **100 Uploads pro Tag und
  Projekt** — für **alle** Nutzer der eingebauten App zusammen. Für viele Streamer: mehr Kontingent
  beantragen (gleiches Formular) oder Streamer nutzen eigene App-Daten.

---

## 2. TikTok

### 2.1 Entwickler-Konto und App
1. <https://developers.tiktok.com/> → **Log in** (mit dem TikTok-Konto des Herausgebers) → Entwickler-Konto anlegen.
2. **Manage apps → Connect an app** → Name `ChaosCore`, Kategorie, Beschreibung, Symbol,
   Links zu **Nutzungsbedingungen** und **Datenschutzerklärung** (Pflicht).
3. Plattform **Desktop** auswählen.

### 2.2 Produkte hinzufügen
1. **Add products → Login Kit**.
   - **Redirect URI** (Desktop): `http://127.0.0.1:*/callback/` — der Stern steht für den Port, den
     ChaosCore bei jeder Anmeldung zufällig wählt.
2. **Add products → Content Posting API**.
   - Nur **Upload** (Entwurf in die Inbox) wird gebraucht, **nicht** „Direct Post“.
3. **Scopes:** `user.info.basic` und `video.upload`.

### 2.3 Prüfung
- Neue Apps laufen zuerst in der **Sandbox**: nur eingetragene Testkonten können sich anmelden.
  Eigenes TikTok-Konto als Testkonto eintragen, dann lässt sich alles ausprobieren.
- Für alle Streamer die App zur **Prüfung** einreichen (Beschreibung + kurzes Video des Ablaufs:
  Verbinden in ChaosCore → Clip → Entwurf erscheint in der TikTok-App).
- TikTok erlaubt höchstens **5 offene Entwürfe in 24 Stunden** pro Konto; ChaosCore zeigt den Stand an.

### 2.4 Zugangsdaten
Unter **App details**: **Client key** und **Client secret** notieren.

---

## 3. App-Daten in ChaosCore einbauen

**Variante A – fertige Builds (empfohlen):** Im GitHub-Repo unter
*Settings → Secrets and variables → Actions → New repository secret* vier Secrets anlegen:

| Name | Wert |
|---|---|
| `UCC_YT_CLIENT_ID` | Google Client-ID |
| `UCC_YT_CLIENT_SECRET` | Google Clientschlüssel |
| `UCC_TT_CLIENT_KEY` | TikTok Client key |
| `UCC_TT_CLIENT_SECRET` | TikTok Client secret |

Der Release-Workflow baut sie beim nächsten Release in `product.json` der Installationsdatei ein.
Im Repo selbst stehen sie nicht.

**Variante B – lokal testen:** Im Dashboard unter *Einstellungen → System → Eigene App-Daten (Entwickler)*
Plattform wählen, Client-ID/Key und Secret eintragen, speichern, **Verbinden**. Die Daten liegen
verschlüsselt im Datenordner dieses PCs.

## 4. Kurz testen
1. ChaosCore → Highlights → Uploads → **Verbinden** bei YouTube und TikTok.
2. Lokale Clips einschalten (OBS verbunden, Wiederholungspuffer an), ffmpeg installieren.
3. Einen Clip erzeugen (z. B. „Clip das!“ im Testlauf) → in der Highlight-Liste **↑ YouTube** und **↑ TikTok**.
4. YouTube Studio: Video ist privat da. TikTok-App: Entwurf unter Benachrichtigungen.
