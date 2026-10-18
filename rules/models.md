# Models — pins, licences, the cache and serving

The detail behind [AGENTS.md](../AGENTS.md) §3 (models) and §2 (§7, §12).

- **Every model is pinned by Hugging Face commit sha and a sha256 per file.**
  A name or a branch (`main`) is never a pin. The catalogue entry
  (`catalogue/<id>.json`) is the pin; docs/architecture/models.html records
  where each value came from and when.
  A hosted model, served by a `ModelProvider` module (docs/architecture/modules.html),
  is pinned instead by the vendor's exact model id as its card gives it — never
  an alias that moves (`latest`), an inference profile or an ARN — with its card,
  launch date, prices, terms and retention policy each by URL and date read,
  checked by the manifest's schema; its price is re-read within 90 days, or the
  docs guard fails (extension-modules R20, 2026-10-02). This replaces the
  commit-sha rule for hosted models only.
- **The licence is verified for the exact repo and revision being served** —
  not the family, not the predecessor (§12). Record the licence id, the URL of
  the licence file at that revision, and the date read.
  - **When the publisher ships no licence file,** the model card declaring it
    is the licence record: its `README.md` at that revision goes in `files`,
    pinned by sha256, and `license.source` points to it. This is the owner's
    decision (2026-09-26): an Apache-2.0 model with no LICENSE file is
    acceptable.
  - **Every model must be under a commercially permissive licence** (the
    owner's requirement).
- **Weights are GGUF or safetensors.** Pickle formats (`.bin`, `.pt`, `.pth`)
  are never downloaded.
- **Only the harness writes the model cache.** Downloads go to a staging
  directory, every file is verified against its sha256, and the directory is
  promoted by a single atomic rename. A digest mismatch is fatal and is never
  retried. The cache is content-addressed: `models/sha256-<tree digest>/`.
- **Model serving runs on the host, agents run in colima.** llama.cpp uses
  Metal, which colima's Linux VM does not expose. A PC build substitutes only
  the llama.cpp install step (a CUDA build); the model files and the
  OpenAI-compatible API it serves are the same. See docs/architecture/models.html.
- **External facts (§12).** Model licences, revisions, digests, and llama.cpp /
  colima behaviour are external facts; docs/architecture/models.html records
  each with source and the date it was read.
- **One model backend (§7).** Adding a second model backend or a second
  container runtime is a new moving part — justify it in writing first. (vLLM
  was evaluated on 2026-09-26 and set aside by the owner: with inference on the
  host rather than in containers, llama.cpp covers Metal and CUDA alike.)
