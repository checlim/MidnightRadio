// Child process for the concurrent-reservation test: try N TTS reservations, print how many succeeded.
import { BudgetLedger } from "../budget.js";
import { BudgetExceededError } from "../errors.js";
import { openDb } from "../open.js";

const [path, cap, chars, tries] = process.argv.slice(2);
const db = openDb(path!);
const ledger = new BudgetLedger(db, { dailyTtsChars: Number(cap), dailyLlmTokens: 0, bookTtsCharCeiling: 1_000_000 });
let ok = 0;
for (let i = 0; i < Number(tries); i++) {
  try {
    ledger.reserve({ bookId: "b1", ttsChars: Number(chars) });
    ok++;
  } catch (e) {
    if (!(e instanceof BudgetExceededError)) throw e;
  }
}
db.close();
console.log(ok);
