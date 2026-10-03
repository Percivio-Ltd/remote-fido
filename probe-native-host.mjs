#!/usr/bin/env node

import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {FrameDecoder, PROTOCOL_VERSION, encodeFrame} from "./protocol.mjs";

const wrapper = process.argv[2] ?? fileURLToPath(new URL("./native-host-wrapper", import.meta.url));
const child = spawn(wrapper, [], {stdio: ["pipe", "pipe", "inherit"]});
const decoder = new FrameDecoder("LE");
const timer = setTimeout(() => {
  console.error("native-host hello timed out");
  child.kill("SIGTERM");
  process.exitCode = 1;
}, 8000);

child.stdout.on("data", chunk => {
  for (const message of decoder.push(chunk)) {
    clearTimeout(timer);
    console.log(JSON.stringify(message));
    process.exitCode = message?.version === PROTOCOL_VERSION &&
      message?.type === "hello" && message?.ready === true ? 0 : 1;
    child.stdin.end();
    child.kill("SIGTERM");
  }
});
child.once("error", error => {
  clearTimeout(timer);
  console.error(error.message);
  process.exitCode = 1;
});
child.stdin.write(encodeFrame({version: PROTOCOL_VERSION, type: "hello"}, "LE"));
