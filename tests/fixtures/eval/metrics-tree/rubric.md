# rubric-v1 (fixture)

Stand-in rubric used only to give the engine a real file to sha256 for
`provenance.rubric_sha256`. The engine's dimension SCORING never reads this
content — only its bytes are hashed — so a frozen fixture cannot time-bomb.
Replaced by the real `skills/eval/rubric-v1.md` once W3 ships it.
