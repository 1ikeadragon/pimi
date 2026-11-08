# Spaces semantic search model

`model.safetensors` and `tokenizer.json` are unmodified files from [MinishLab Potion Base 2M](https://huggingface.co/minishlab/potion-base-2M/tree/389b9f64be5aa4ae7a6bc6fe95ef20ce485ae5da), revision `389b9f64be5aa4ae7a6bc6fe95ef20ce485ae5da`. The model card declares the MIT license. [LICENSE](LICENSE) contains the notice published by the [upstream Model2Vec project](https://github.com/MinishLab/model2vec/blob/f6052f3b3ef4e0a60937a2fcc3d3aed95c80fa5a/LICENSE).

| File                | SHA-256                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `model.safetensors` | `f95ffde02ad06f63ae38eb9d400038cd5ccaf8411ec3cb650c6025113f96cbb8` |
| `tokenizer.json`    | `e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50` |

The files are bundled for Spaces search. The daemon reads them locally and uses the Apache-2.0 [Tokenizers.js](https://github.com/huggingface/tokenizers.js) library for WordPiece tokenization.
