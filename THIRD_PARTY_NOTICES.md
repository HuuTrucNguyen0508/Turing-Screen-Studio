# Third-party notices

The bundled fonts and external hardware driver keep their own licenses, separate from the application's license.

## Roboto

`public/fonts/Roboto-Regular.ttf` is the Roboto font from Google's Roboto project. Its embedded copyright notice is Copyright 2011 Google Inc. All Rights Reserved. The bundled font uses the Apache License, Version 2.0. The full license is included in [public/fonts/roboto-LICENSE.txt](public/fonts/roboto-LICENSE.txt).

The primary source for this font generation is [googlefonts/roboto-2](https://github.com/googlefonts/roboto-2). Its [upstream license](https://github.com/googlefonts/roboto-2/blob/main/LICENSE) is Apache-2.0. This notice refers to the bundled Roboto font, not to every later Roboto release or variant.

## JetBrains Mono

`public/fonts/JetBrainsMono-Regular.ttf` is JetBrains Mono. Copyright 2020 The JetBrains Mono Project Authors. It uses the SIL Open Font License, Version 1.1. The full copyright notice and license are included in [public/fonts/jetbrains-mono-OFL.txt](public/fonts/jetbrains-mono-OFL.txt).

See the [JetBrains Mono project](https://github.com/JetBrains/JetBrainsMono) and its [upstream OFL](https://github.com/JetBrains/JetBrainsMono/blob/master/OFL.txt).

## External USB driver

The experimental legacy integration uses a separately installed copy of [turing-smart-screen-python](https://github.com/mathoudebine/turing-smart-screen-python). That project's [license](https://github.com/mathoudebine/turing-smart-screen-python/blob/main/LICENSE) is GNU GPL version 3. Its driver code is not vendored in this repository.

The legacy integration expects that installation at `~/Documents/turing-smart-screen-python`. Cloning this repository does not install the driver or its dependencies. See [panel integration](docs/panel-integration.md) for the existing machine's adapter requirements.

## Package dependencies

JavaScript dependencies are listed in `package.json` and resolved in `pnpm-lock.yaml`; the optional Python dependency is declared in `requirements.txt`. Their license notices remain with the installed packages. Preserve the bundled font notices when redistributing the editor's local assets.
