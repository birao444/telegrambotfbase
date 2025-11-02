Apps Script WebApp · Google Picker Panel (Admins)

Overview
- Admin-only Apps Script WebApp that opens Google Picker to choose files from Drive, posts the selected file to a Telegram chat, and logs the action into a Google Sheet (`files_log`).
- Includes an external `doPost` to allow backend-to-backend triggers if needed.

Files
- `apps-script/Code.gs`: Server-side logic (doGet, doPost, Picker config, sendDocument to Telegram, logging in Sheets).
- `apps-script/index.html`: Minimal UI with Picker, caption and chatId inputs.
- `apps-script/appsscript.json`: Manifest with required scopes.

Prerequisites
- Google Workspace or Google account able to deploy Apps Script.
- Google Cloud project with:
  - OAuth Client ID (type Web application) for Google Picker usage.
  - API Key for the Picker.
- Telegram Bot token and a chat ID where to post.
- A Google Spreadsheet to act as `files_log`.

Configuration
1) Create Spreadsheet for logs
   - Create a Google Spreadsheet (empty) and copy its ID.
   - In `Code.gs` set `FILES_LOG_SPREADSHEET_ID` to that ID.

2) Telegram
   - Create a bot with @BotFather and obtain `TELEGRAM_BOT_TOKEN`.
   - Set `DEFAULT_TELEGRAM_CHAT_ID` to a target chat (for channels/supergroups it starts with `-100…`).

3) Picker credentials
   - In Google Cloud Console, enable "Google Picker API" and "Google Drive API" for your project.
   - Create an API Key → set as `PICKER_API_KEY`.
   - Create OAuth client ID (type Web application). Add the Apps Script WebApp URL as an authorized redirect origin later if needed. Set client ID as `PICKER_CLIENT_ID`.
   - Set `PICKER_APP_ID` to your GCP Project Number (or App ID in legacy terms).

4) Admins
   - Set the `ADMIN_EMAILS` array to the list of allowed admin emails.

5) Scopes
   - The manifest already declares needed scopes: Drive readonly, Sheets, external requests, and user email.

Deploy
1) Open this folder in Apps Script (alternatives):
   - Create a new Apps Script project, then copy contents of `Code.gs`, `index.html`, and `appsscript.json`.
   - Or use clasp to push these files to an Apps Script project.

2) Deploy as WebApp
   - In Apps Script: Deploy → New deployment → Type: Web app.
   - Execute as: User accessing the web app.
   - Who has access: Anyone (the panel also checks admin emails internally).
   - Copy the WebApp URL.

3) Test
   - Open the WebApp URL while signed in as an admin email.
   - Click "Seleccionar archivo", choose a file, add an optional caption, and send.
   - Verify the file is posted to Telegram and a row is added to the `files_log` sheet.

Notes
- Picker needs to open in direct response to a click on mobile to avoid popup blocking; this UI uses a button for that.
- This implementation uploads the file content to Telegram (multipart upload). No public Drive sharing is required.
- If `Session.getActiveUser().getEmail()` returns empty (consumer accounts), only users within a Workspace may be reliably recognized for admin gating. Otherwise consider protecting the WebApp behind Google Workspace or use additional app-level auth.
- The `doPost` accepts JSON `{ fileId, caption, chatId }` and uses the same send/log flow. You can call it from other backends if desired.

