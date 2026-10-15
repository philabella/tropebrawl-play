# Tropebrawl playtest run log

Finished (and abandoned) runs from the playtest page, one JSON file per run: `runs/<player id>/<run id>.json`.
Anonymous: the player id is random and stored only in the player's browser; a record holds the game version, Game
Level, and per round the gold, lives, shop rank, actions (`b:` buy, `s:` sell, `r` reroll, `t` train, `o:` shop
offer, `l:` Legendary, `i:` item, `e:` event, `c:` choice) and the board at the fight.

Written by `.github/workflows/runlog.yml` on the `main` branch (every 6 hours, from the ntfy.sh relay the game posts
to). Started here 2026-10-15 with the runs collected so far in the developer's repo.
