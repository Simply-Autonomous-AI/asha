# Third-party licences

What asha uses that others made, each under its own licence (docs/plans/oss-release.md R29). asha's own licence is in [LICENSE](./LICENSE). Read on 2026-10-16 unless a row says otherwise: the packages from `package-lock.json` and their own licence files as installed, the host tools from their Homebrew formulae, the base images from the Dockerfiles that pin them, and each model's licence file at its pinned revision.

## Packages asha runs with

The production dependency tree (`npm ls --omit=dev --all`), every package of it, shipped in a release's tarball:

| Package | Version | Licence |
|---|---|---|
| `@opentelemetry/api` | 1.9.1 | Apache-2.0 |
| `@opentelemetry/api-logs` | 0.222.0 | Apache-2.0 |
| `@opentelemetry/core` | 2.11.0 | Apache-2.0 |
| `@opentelemetry/exporter-trace-otlp-http` | 0.222.0 | Apache-2.0 |
| `@opentelemetry/otlp-exporter-base` | 0.222.0 | Apache-2.0 |
| `@opentelemetry/otlp-transformer` | 0.222.0 | Apache-2.0 |
| `@opentelemetry/resources` | 2.11.0 | Apache-2.0 |
| `@opentelemetry/sdk-logs` | 0.222.0 | Apache-2.0 |
| `@opentelemetry/sdk-metrics` | 2.11.0 | Apache-2.0 |
| `@opentelemetry/sdk-trace` | 2.11.0 | Apache-2.0 |
| `@opentelemetry/semantic-conventions` | 1.43.0 | Apache-2.0 |

## Packages used only to build and test

The development dependencies, by licence. They are installed by `npm install` in a checkout, never shipped in a release:

| Licence | Packages |
|---|---|
| 0BSD | 1: `tslib` |
| Apache-2.0 | 16: `@eslint/config-array`, `@eslint/config-helpers`, `@eslint/core`, `@eslint/object-schema`, `@eslint/plugin-kit`, `@humanfs/core`, `@humanfs/node`, `@humanfs/types`, `@humanwhocodes/module-importer`, `@humanwhocodes/retry`, `detect-libc`, `eslint-visitor-keys`, `expect-type`, `playwright-core`, `typescript` |
| BSD-2-Clause | 6: `eslint-scope`, `espree`, `esrecurse`, `estraverse`, `esutils`, `uri-js` |
| BSD-3-Clause | 3: `esquery`, `smol-toml`, `source-map-js` |
| BlueOak-1.0.0 | 1: `minimatch` |
| ISC | 10: `flatted`, `glob-parent`, `isexe`, `knip`, `picocolors`, `semver`, `unbash`, `walk-up-path`, `which`, `yaml` |
| LGPL-3.0-only | 2: `@sonarsource/analyzer-commons-configurations`, `eslint-plugin-sonarjs` |
| MIT | 189: `@babel/helper-string-parser`, `@babel/helper-validator-identifier`, `@babel/parser`, `@babel/types`, `@bcoe/v8-coverage`, `@cacheable/memory`, `@cacheable/utils`, `@emnapi/core`, `@emnapi/runtime`, `@emnapi/wasi-threads`, `@eslint-community/eslint-utils`, `@eslint-community/regexpp`, `@eslint/js`, `@jridgewell/resolve-uri`, `@jridgewell/sourcemap-codec`, `@jridgewell/trace-mapping`, `@keyv/bigmap`, `@keyv/serialize`, `@napi-rs/wasm-runtime`, `@oxc-parser/binding-android-arm-eabi`, `@oxc-parser/binding-android-arm64`, `@oxc-parser/binding-darwin-arm64`, `@oxc-parser/binding-darwin-x64`, `@oxc-parser/binding-freebsd-x64`, `@oxc-parser/binding-linux-arm-gnueabihf`, `@oxc-parser/binding-linux-arm-musleabihf`, `@oxc-parser/binding-linux-arm64-gnu`, `@oxc-parser/binding-linux-arm64-musl`, `@oxc-parser/binding-linux-ppc64-gnu`, `@oxc-parser/binding-linux-riscv64-gnu`, `@oxc-parser/binding-linux-riscv64-musl`, `@oxc-parser/binding-linux-s390x-gnu`, `@oxc-parser/binding-linux-x64-gnu`, `@oxc-parser/binding-linux-x64-musl`, `@oxc-parser/binding-openharmony-arm64`, `@oxc-parser/binding-win32-arm64-msvc`, `@oxc-parser/binding-win32-ia32-msvc`, `@oxc-parser/binding-win32-x64-msvc`, `@oxc-project/types`, `@oxc-resolver/binding-android-arm-eabi`, `@oxc-resolver/binding-android-arm64`, `@oxc-resolver/binding-darwin-arm64`, `@oxc-resolver/binding-darwin-x64`, `@oxc-resolver/binding-freebsd-x64`, `@oxc-resolver/binding-linux-arm-gnueabihf`, `@oxc-resolver/binding-linux-arm-musleabihf`, `@oxc-resolver/binding-linux-arm64-gnu`, `@oxc-resolver/binding-linux-arm64-musl`, `@oxc-resolver/binding-linux-ppc64-gnu`, `@oxc-resolver/binding-linux-riscv64-gnu`, `@oxc-resolver/binding-linux-riscv64-musl`, `@oxc-resolver/binding-linux-s390x-gnu`, `@oxc-resolver/binding-linux-x64-gnu`, `@oxc-resolver/binding-linux-x64-musl`, `@oxc-resolver/binding-openharmony-arm64`, `@oxc-resolver/binding-wasm32-wasi`, `@oxc-resolver/binding-win32-arm64-msvc`, `@oxc-resolver/binding-win32-x64-msvc`, `@rolldown/binding-android-arm-eabi`, `@rolldown/binding-android-arm64`, `@rolldown/binding-darwin-arm64`, `@rolldown/binding-darwin-x64`, `@rolldown/binding-freebsd-x64`, `@rolldown/binding-linux-arm-gnueabihf`, `@rolldown/binding-linux-arm64-gnu`, `@rolldown/binding-linux-arm64-musl`, `@rolldown/binding-linux-ppc64-gnu`, `@rolldown/binding-linux-s390x-gnu`, `@rolldown/binding-linux-x64-gnu`, `@rolldown/binding-linux-x64-musl`, `@rolldown/binding-openharmony-arm64`, `@rolldown/binding-win32-arm64-msvc`, `@rolldown/binding-win32-x64-msvc`, `@rolldown/pluginutils`, `@tybys/wasm-util`, `@types/chai`, `@types/deep-eql`, `@types/esrecurse`, `@types/estree`, `@types/json-schema`, `@types/node`, `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, `@typescript-eslint/project-service`, `@typescript-eslint/scope-manager`, `@typescript-eslint/tsconfig-utils`, `@typescript-eslint/type-utils`, `@typescript-eslint/types`, `@typescript-eslint/typescript-estree`, `@typescript-eslint/utils`, `@typescript-eslint/visitor-keys`, `@vitest/coverage-v8`, `@vitest/istanbul-lib-coverage`, `@vitest/istanbul-lib-report`, `@vitest/mocker`, `@vitest/spy`, `acorn`, `acorn-jsx`, `ajv`, `assertion-error`, `ast-v8-to-istanbul`, `balanced-match`, `brace-expansion`, `builtin-modules`, `bytes`, `cacheable`, `chai`, `cross-spawn`, `debug`, `deep-is`, `es-module-lexer`, `escape-string-regexp`, `eslint`, `estree-walker`, `fast-deep-equal`, `fast-json-stable-stringify`, `fast-levenshtein`, `fd-package-json`, `fdir`, `file-entry-cache`, `find-up`, `flat-cache`, `formatly`, `fsevents`, `functional-red-black-tree`, `get-tsconfig`, `globals`, `hashery`, `hookified`, `ignore`, `imurmurhash`, `is-extglob`, `is-glob`, `jiti`, `js-tokens`, `json-schema-traverse`, `json-stable-stringify-without-jsonify`, `jsx-ast-utils-x`, `keyv`, `levn`, `locate-path`, `lodash.merge`, `magic-string`, `magicast`, `marked`, `ms`, `nanoid`, `natural-compare`, `obug`, `optionator`, `oxc-parser`, `oxc-resolver`, `p-limit`, `p-locate`, `package-manager-detector`, `path-exists`, `path-key`, `picomatch`, `postcss`, `prelude-ls`, `prettier`, `punycode`, `qified`, `refa`, `regexp-ast-analysis`, `resolve-pkg-maps`, `rolldown`, `scslre`, `shebang-command`, `shebang-regex`, `std-env`, `strip-json-comments`, `tinybench`, `tinyexec`, `tinyglobby`, `tinyrainbow`, `ts-api-utils`, `type-check`, `typescript-eslint`, `undici-types`, `vite`, `vitest`, `why-is-node-running`, `word-wrap`, `yocto-queue`, `zod` |
| MPL-2.0 | 12: `lightningcss`, `lightningcss-android-arm64`, `lightningcss-darwin-arm64`, `lightningcss-darwin-x64`, `lightningcss-freebsd-x64`, `lightningcss-linux-arm-gnueabihf`, `lightningcss-linux-arm64-gnu`, `lightningcss-linux-arm64-musl`, `lightningcss-linux-x64-gnu`, `lightningcss-linux-x64-musl`, `lightningcss-win32-arm64-msvc`, `lightningcss-win32-x64-msvc` |

## Host tools asha installs

Installed with Homebrew the first time each is needed, never shipped:

| Tool | What for | Licence | Source |
|---|---|---|---|
| colima | the VM the agent containers run in | MIT | Homebrew formula `colima` (0.10.3), <https://colima.run> |
| docker (the CLI) | the containers' commands | Apache-2.0 | Homebrew formula `docker` (29.9.0), <https://www.docker.com/> |
| llama.cpp (`llama-server`) | serving the models on the host, Metal | MIT | Homebrew formula `llama.cpp` (0.6.0), <https://llama.app> |
| gitleaks | the secret scan, for the tests only | MIT | Homebrew formula `gitleaks` (8.30.1), <https://gitleaks.io/> |

## Base images

Pulled by digest and built on in the colima VM, never shipped: Docker's official `node` images, whose build files are MIT and which hold Node.js (MIT) and their distribution's packages, each under its own licence.

- `node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32`
- `node:22-bookworm-slim@sha256:d415caac2f1f77b98caaf9415c5f807e14bc8d7bdea62561ea2fef4fbd08a73c`

## Models

Downloaded from Hugging Face by the user's machine, pinned by revision and checked by sha256, never redistributed here. Each licence file was read at the revision named; its copyright line is quoted as the file gives it:

| Model | Repository | Revision | Licence | Licence file | Copyright line | Read |
|---|---|---|---|---|---|---|
| `pico-v2-q8_0` | `OculusMindAI/OculusMind-ToolCall-8B-v2` | `3a3d1b36fbfd397e67545786057b0e335a8efffc` | apache-2.0 | <https://huggingface.co/OculusMindAI/OculusMind-ToolCall-8B-v2/blob/3a3d1b36fbfd397e67545786057b0e335a8efffc/LICENSE> | Copyright 2026 Andrew Paris LLC | 2026-10-16 (catalogue 2026-10-09) |
| `qwen3-0.6b-q8_0` | `Qwen/Qwen3-0.6B-GGUF` | `23749fefcc72300e3a2ad315e1317431b06b590a` | apache-2.0 | <https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/blob/23749fefcc72300e3a2ad315e1317431b06b590a/LICENSE> | Copyright 2025 Alibaba Cloud | 2026-10-16 (catalogue 2026-09-26) |
| `qwen3-1.7b-q8_0` | `Qwen/Qwen3-1.7B-GGUF` | `90862c4b9d2787eaed51d12237eafdfe7c5f6077` | apache-2.0 | <https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/blob/90862c4b9d2787eaed51d12237eafdfe7c5f6077/LICENSE> | Copyright 2025 Alibaba Cloud | 2026-10-16 (catalogue 2026-09-26) |
| `qwen3-4b-q4_k_m` | `Qwen/Qwen3-4B-GGUF` | `bc640142c66e1fdd12af0bd68f40445458f3869b` | apache-2.0 | <https://huggingface.co/Qwen/Qwen3-4B-GGUF/blob/bc640142c66e1fdd12af0bd68f40445458f3869b/LICENSE> | Copyright 2025 Alibaba Cloud | 2026-10-16 (catalogue 2026-09-26) |
| `qwen3-8b-q4_k_m` | `Qwen/Qwen3-8B-GGUF` | `7c41481f57cb95916b40956ab2f0b139b296d974` | apache-2.0 | <https://huggingface.co/Qwen/Qwen3-8B-GGUF/blob/7c41481f57cb95916b40956ab2f0b139b296d974/LICENSE> | Copyright 2025 Alibaba Cloud | 2026-10-16 (catalogue 2026-09-26) |
| `qwen3-embedding-0.6b-q8_0` | `Qwen/Qwen3-Embedding-0.6B-GGUF` | `370f27d7550e0def9b39c1f16d3fbaa13aa67728` | apache-2.0 | <https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/blob/370f27d7550e0def9b39c1f16d3fbaa13aa67728/README.md> | none | 2026-10-16 (catalogue 2026-09-26) |
| `qwen3.5-2b-base` | `Qwen/Qwen3.5-2B-Base` | `b1485b2fa6dfa1287294f269f5fb618e03d52d7c` | apache-2.0 | <https://huggingface.co/Qwen/Qwen3.5-2B-Base/blob/b1485b2fa6dfa1287294f269f5fb618e03d52d7c/LICENSE> | Copyright 2026 Alibaba Cloud | 2026-10-16 (catalogue 2026-10-03) |
| `strands-decider-2b-hobson-v19` | `StrandsAgents/strands-decider-2B-hobson-v19` | `bb282d786bc251fd4e3068de3ada9ddbb38127cd` | apache-2.0 | <https://huggingface.co/StrandsAgents/strands-decider-2B-hobson-v19/blob/bb282d786bc251fd4e3068de3ada9ddbb38127cd/LICENSE.md> | none | 2026-10-16 (catalogue 2026-10-03) |

## Licence texts

### Apache-2.0

As the `@opentelemetry/api` package holds it, and every production package above declares it:

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```
