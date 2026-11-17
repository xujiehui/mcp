# Third-party notices

`src/vendor/genome.js` is adapted from [Cc-Zzh1/moonvy-ui-mcp](https://github.com/Cc-Zzh1/moonvy-ui-mcp), commit `0021b2b1f0813c252708b041166f77dbff92d851`, under the MIT license reproduced in `LICENSE`.

Changes: explicit per-call units (default px); percent letter spacing; normalized per-run typography, links and decorations; inner shadows; composed color/gradient fills and simple solid strokes; explicit coordinate-space handling; retention of raw fill/stroke/effect parameters with unsupported CSS omitted; and removal of unused traversal/token helpers. The TypeScript adapter adds indexing, response projection, pagination, raw-data retention, transforms and advisory layout hints. Coordinate conversion and gradient/CSS math originate from the reference implementation. Moonvy's private API and Genome format may change.

`baselines/upstream-panel.json` is adapted from the same commit's `test/fixtures/css-panel-baselines.json`. Only the container schema was converted; the upstream author's 2026-09-14 panel observations remain unchanged. They are independently sourced expectations, not independently reverified online by this project. See `baselines/README.md` for provenance and verification commands.

The Figma MCP [tools and prompts documentation](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/) inspired the read workflow. This project does not include Figma proprietary server code and does not claim Figma protocol or feature parity.
