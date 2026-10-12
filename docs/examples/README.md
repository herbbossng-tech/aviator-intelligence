# Example import files (SYNTHETIC)

**Every file in this directory is synthetic.** The values were invented to show the file formats and the validation rules. They are not real Aviator or SportyBet history and must not be analysed as if they were.

| File                               | Purpose                                                                                                                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `synthetic-rounds.csv`             | Valid CSV. Includes an offset timestamp, a missing `eventAt` and a missing `sourceRoundId`.                                                                                                                 |
| `synthetic-rounds.json`            | Valid JSON using the `{"rounds": [...]}` wrapper. Includes a numeric multiplier.                                                                                                                            |
| `synthetic-rounds-with-errors.csv` | Shows each rejection. Record 2 is below 1.00x, record 3 has three decimals, record 4 has no time zone, record 5 repeats record 1 (skipped as a repeat in the file), and record 6 is missing its multiplier. |

To try them without touching your real database, point the API at a throwaway database:

```bash
AVIATOR_DB_PATH=data/scratch.sqlite npm run dev
```

Use a source label such as `synthetic-example` when importing them. Delete `data/scratch.sqlite*` afterwards.
