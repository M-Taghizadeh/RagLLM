"""
Persian text normalization for the sparse (BM25) retriever.

BM25Retriever from LangChain tokenizes with a plain str.split() by default,
which is weak for Persian: Arabic-vs-Persian letter variants (ي/ی، ك/ک),
diacritics, half-space (ZWNJ) inconsistencies and stray punctuation all
create duplicate/mismatched tokens and hurt recall. This module gives BM25
a `preprocess_func` that normalizes and tokenizes Persian (and mixed
Persian/English) text consistently.

No extra dependency is required. If the `hazm` package is installed,
its normalizer is used for a further quality bump (proper ZWNJ handling,
number/punctuation normalization); otherwise a regex-based fallback is used.
"""

from __future__ import annotations

import re
from typing import List

try:
    from hazm import Normalizer as _HazmNormalizer
    _hazm_normalizer = _HazmNormalizer()
except Exception:
    _hazm_normalizer = None

# Arabic → Persian letter unification
_CHAR_MAP = {
    "ي": "ی", "ك": "ک", "ة": "ه", "ؤ": "و", "إ": "ا", "أ": "ا",
    "ۀ": "ه", "ٱ": "ا", "‌": " ",  # ZWNJ -> space (simplifies tokenization)
}

# Arabic diacritics (tashkeel) + tatweel
_DIACRITICS_RE = re.compile(r"[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]")

# Persian/Arabic digits -> ASCII digits (helps matching numbers in queries)
_DIGIT_MAP = str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")

_TOKEN_RE = re.compile(r"[\w]+", re.UNICODE)

# Minimal Persian stopword list (kept short and safe — removing too many
# hurts short queries). Extend if you install hazm's fuller list.
_STOPWORDS = {
    "و", "در", "به", "از", "که", "این", "را", "با", "است", "برای",
    "آن", "یک", "تا", "بر", "هم", "می", "شود", "شد", "کرد", "کند",
    "های", "ها", "یا", "اما", "نیز", "دیگر", "چون", "اگر", "بود",
}


def normalize_fa(text: str) -> str:
    """Unify Arabic/Persian variants, strip diacritics, unify digits."""
    if _hazm_normalizer is not None:
        text = _hazm_normalizer.normalize(text)
    for src, dst in _CHAR_MAP.items():
        text = text.replace(src, dst)
    text = _DIACRITICS_RE.sub("", text)
    text = text.translate(_DIGIT_MAP)
    return text


def persian_tokenize(text: str, remove_stopwords: bool = True) -> List[str]:
    """Normalize + tokenize. Pass as `preprocess_func` to BM25Retriever."""
    text = normalize_fa(text)
    tokens = _TOKEN_RE.findall(text.lower())
    if remove_stopwords:
        tokens = [t for t in tokens if t not in _STOPWORDS]
    return tokens
