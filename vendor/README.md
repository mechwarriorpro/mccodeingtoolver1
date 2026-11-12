# vendor/

Optional third-party installers that the app can ship inside its own installer.

## OllamaSetup.exe

Settings → **Local models** needs Ollama. There are two ways it gets there:

1. **Downloaded at run time** (the default). The app fetches the official
   installer from GitHub when the user presses *Download and install Ollama*.
2. **Bundled with the app.** Put `OllamaSetup.exe` in this folder **before**
   running `npm run dist:win`. `electron-builder.yml` copies it into the app's
   resources, and the installer offers it instead of downloading.

The bundled route makes the app work on a machine with no internet, at the cost
of a much bigger `.exe`: the Ollama installer is roughly 1 GB, so the packaged
app grows from about 108 MB to about 1.1 GB.

`OllamaSetup.exe` is **not** committed here — it is in `.gitignore` because of its
size, and because each Ollama release changes it. Download the current one:

    https://github.com/ollama/ollama/releases/latest/download/OllamaSetup.exe

That is the same URL the app uses at run time, and the same file from the same
publisher. If you bundle it, check the release notes for the version you ship.

**Licence:** Ollama is MIT licensed. Redistributing its unmodified official
installer is permitted; do not modify the binary.

Model weights are never bundled — they are multi-gigabyte and are pulled from
Ollama's own registry on demand, only for the models the user selects.
