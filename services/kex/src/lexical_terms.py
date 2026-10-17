"""Term selection for the OR-relaxation pass of the lexical /search channel.

The lexical channel first runs `websearch_to_tsquery(query)`, which ANDs every
word. A conversational question ("Fasse mir bitte die Ergebnisse ... zusammen")
rarely has all its words in one chunk, so for anything longer than a few words
that strict pass is empty and the channel falls back to an OR over the query's
tokens. Before this module that OR took EVERY token, stopwords included:

  * cost — a chat message of ~1000 characters becomes ~100 OR terms, "die",
    "und", "ist" among them. That matches most of the corpus, Postgres gives up
    on the GIN index (parallel seq scan) and computes `ts_rank_cd` for every
    match. Measured on Asgard (65k chunks, 2026-10-17): 5.6 s at 1000 chars,
    13.7 s at 1800 chars — the whole budget of Anvil's per-turn KB lookup;
  * quality — `ts_rank_cd` then rewards chunks dense in "die"/"und", not the
    topic. Dropping the stopwords alone doubled the overlap with the dense
    channel's top 50 on real Anvil queries (0.05 -> 0.10).

So the OR pass gets the query's CONTENT words only, capped at `MAX_OR_TERMS`,
longest first (a long word is the rarer, more specific one — "Redispatch",
"Kurzantwort" — and needs no corpus statistics to find). Measured: the capped
pass costs <= ~0.3 s for any query length, and its agreement with the dense
channel stayed above the uncapped pass (0.084 vs 0.050).

Parameters are un-annotated on purpose: this module is Cython-compiled in the
prod image, where a `list`/`dict` annotation is an exact type check.
"""

MAX_OR_TERMS = 16

# The 'simple' text-search config the lexical channel uses removes no stopwords,
# so they are removed here. German + English, lowercase; kept small and obvious —
# a word missing here only costs a little ranking quality, never correctness.
STOPWORDS = frozenset("""
aber alle allem allen aller alles als also am an andere anderen auch auf aus
bei beim bin bis bist bitte da dabei dadurch daher damit dann darauf darum das
dass daß dein deine deiner dem den denn der des dessen deshalb dich die dies
diese diesem diesen dieser dieses dir doch dort du durch ein eine einem einen
einer eines er es etwa etwas euch euer für fur gegen ganz gar gibt hab habe
haben hat hatte hätte hier ich ihm ihn ihnen ihr ihre im immer in ins ist ja
je jede jedem jeden jeder jedes jetzt kann kannst kein keine keinen können
konnte könnte mal man mehr mein meine meinem meinen meiner mich mir mit muss
musst nach nicht nichts noch nun nur ob oder ohne sehr sei sein seine seinem
seinen seiner selbst sich sie sind so soll sollen sollte sondern sonst sowie
über um und uns unser unsere unserem unseren unserer unter viel viele vom von
vor war waren warum was weil weiter welche welchem welchen welcher welches wenig
wenn wer werde werden wie wieder will wir wird wo wurde wurden würde zu zum zur
zwar zwischen
a about after all also an and any are as at be been being but by can could did
do does for from had has have he her his how i if in into is it its just me
more my no not of on or our out over she should so than that the their them
then there these they this those to under up us was we were what when where
which who whom why will with would you your
""".split())


def _tokens(query):
    """The same tokenization the OR pass has always used: alphanumeric runs."""
    cleaned = "".join(c if c.isalnum() else " " for c in (query or ""))
    return cleaned.split()


def _is_content_word(word):
    low = word.lower()
    if low in STOPWORDS:
        return False
    if len(low) >= 3:
        return True
    # Two characters only count when they look like an identifier: an acronym
    # ("KI", "IT") or something with a digit ("Q3"). "es", "zu" do not.
    return len(word) == 2 and (word.isupper() or any(c.isdigit() for c in word))


def or_relaxation_terms(query, max_terms=MAX_OR_TERMS):
    """Content words of `query` for the OR pass: stopwords dropped, de-duplicated
    case-insensitively (first spelling wins), at most `max_terms`, longest first.
    Ties keep the order of appearance. Empty when nothing is left."""
    seen = set()
    words = []
    for w in _tokens(query):
        low = w.lower()
        if low in seen or not _is_content_word(w):
            continue
        seen.add(low)
        words.append(w)
    # sorted() is stable, so equal lengths stay in order of appearance.
    words = sorted(words, key=lambda w: -len(w))
    return words[: max(0, int(max_terms))]
