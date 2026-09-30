# Mac local dashboard preview

This is an Apple Silicon/macOS local preview. It packages the existing MCP server,
Node.js, and the repository-pinned OpenAI `tunnel-client` into a drag-and-drop DMG.
The app opens a local browser dashboard; macOS LaunchAgents keep the dashboard
and any enabled backend/tunnels running after the page is closed. No public
port is opened. The dashboard shows Chat Bridge's local accounts, actual Project
bindings, workgroups, queue, and task cache without launching Ego Lite.

Build on a Mac with Node 22+, Corepack, Python 3, and Apple command-line tools:

```sh
bash macos/build-dmg.sh
```

Open `build/macos/ChatGPT Computer.dmg`, drag the app to Applications, then
open it from Applications. To keep the local dashboard available after login,
run this once:

```sh
"$HOME/Applications/ChatGPT Computer.app/Contents/Resources/runtime/node" \
  "$HOME/Applications/ChatGPT Computer.app/Contents/Resources/runtime/manager.mjs" --install-dashboard
```

The dashboard
is at `http://127.0.0.1:3211/`; open the app once to authorize the browser,
then bookmark that address. Its browser cookie lasts seven days, after which
opening the app again renews it. The local build is ad-hoc signed, not notarized
for distribution. After choosing folders and starting the service, add one OpenAI
tunnel ID and runtime API key per ChatGPT account. Create each tunnel in that
account's [OpenAI tunnel settings](https://platform.openai.com/settings/organization/tunnels),
then create a ChatGPT developer-mode connection with `Connection: Tunnel` and
that tunnel ID. Test `system.info` inside each account.

All accounts share the same folder and capability grants. The dashboard can
enable filesystem writes inside those folders, broad command execution as the
signed-in Mac user, and separate main-display screenshot and pointer/keyboard tools. Broad
commands are **not** confined to the selected folders. macOS Screen Recording
and Accessibility permissions may be required for desktop tools; opening a
switch does not grant those system permissions. Screen recording to MP4,
service control, process killing, and application launching remain off.

The dashboard has three views: Project/task relationships, ChatGPT accounts and
connections, and Mac access. Link each connection to a Bridge-verified ChatGPT
login; its display name can be changed independently. The tunnel then stamps a
stable account-origin hint on MCP calls, so Bridge can select that login's bound
Project. Older connections still use a Space label until relinked. The hint does
not identify the source Chat or its Project and is not an authentication boundary.
An unknown origin or missing Project binding fails closed. A Project binding is
shown as unverified if that login's observed catalog contains different Projects.

Project settings, account capacity, workgroups, and verified Project bindings can
be adjusted in the dashboard after installing Chat Bridge's coordinator. Queue
status is a delivery receipt; a sent message is not completed business work.
The dashboard cannot prove that a ChatGPT account actually called a tool or that
an agent finished a task. It does not enable screen control or alter the watchdog.
macOS may also require Files and Folders permission for protected
locations such as Desktop or Documents. The app saves tunnel keys separately under
`~/Library/Application Support/ChatGPT Computer/secrets/` with owner-only file
permissions. Stop a tunnel from the dashboard to revoke its local connection;
revoke the tunnel/API key in OpenAI settings when retiring an account.
