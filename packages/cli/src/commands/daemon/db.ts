import { Command } from "commander";
import { dumpPimiDatabaseTable, resolvePimiHome } from "@pimi/server/daemon-control";

export function daemonDbCommand(): Command {
  const db = new Command("db").description("Inspect the daemon database (local, read-only)");
  db.command("dump")
    .description("Print every row of a table as JSON")
    .argument("<table>", "Table name, e.g. agents")
    .option("--home <path>", "Pimi home directory")
    .action(async (table: string, options: { home?: string }) => {
      const home = options.home ?? resolvePimiHome();
      try {
        console.log(JSON.stringify(await dumpPimiDatabaseTable(home, table), null, 2));
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
  return db;
}
