# Server Tests

Regression tests for `analyze_server.py`. Tests every endpoint with real audio files.

## Quick start

```bash
# From the project root — server must be running
python analyze_server.py &

# First run: generates reference files
python tests/server_tests.py

# Inspect and commit the reference files
git add tests/references/
git commit -m "Add formant analysis reference data"

# Subsequent runs: compares against references
python tests/server_tests.py
```

## Usage

```
python tests/server_tests.py                    # run all tests
python tests/server_tests.py analyze            # /analyze only
python tests/server_tests.py analyze_file       # /analyze-file only
python tests/server_tests.py analyze_debug      # /analyze-debug only
python tests/server_tests.py ws                 # /ws only
python tests/server_tests.py --update           # regenerate all reference files
python tests/server_tests.py --list             # list all test case IDs
```

## Files

```
tests/
├── server_tests.py     ← test runner (edit CASES to add/remove audio files)
├── README.md
└── references/         ← created automatically on first run; commit these
    ├── analyze/
    ├── analyze_file/
    ├── analyze_debug/
    └── ws/
```

## Adding a test case

Edit `CASES` in `server_tests.py`. Example:

```python
CASES['analyze'].append({
    'id':           'my_vowel',
    'audio':        'lang/me/audio/my_vowel.wav',
    'window_start': 0.15,
    'window_end':   0.85,
    'description':  '/x/ my new vowel',
})
```

Run once to save the reference, inspect `tests/references/analyze/my_vowel.json`, commit.

## What each test verifies

| Endpoint        | Compares                                                          |
|-----------------|-------------------------------------------------------------------|
| `/analyze`      | F1, F2 (exact match by default)                                   |
| `/analyze-file` | voiced frame count, mean F1/F2, every frame's voiced/F1/F2       |
| `/analyze-debug`| raw Praat formant values for FRONT, BACK, and SCAN configs        |
| `/ws`           | chunks sent, frames received, voiced count, mean F1/F2, every frame |

## Tolerance

`TOLERANCE_HZ = 0` means exact match. Praat is deterministic on the same machine,
so this should always pass. If comparing across OS/Praat versions, set it to 5.