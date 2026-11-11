import { startEventLoopWatchdog } from "../../src/maintenance/event-loop-watchdog.js";

function spinForever(): never {
  let turns = 0;
  for (;;) turns++;
}

startEventLoopWatchdog("fixture", Number(process.argv[2]));
setTimeout(spinForever, 100);
