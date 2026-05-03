#!/usr/bin/env node
/**
 * DNA Protocol CLI — thin wrapper.
 *
 * All protocol entries are mesh nodes (dna://protocol/<slug>). This file is
 * a forwarder to the generic typed-CLI factory.
 */
import { makeTypedCli } from "../lib/typed-cli.ts";

const main = makeTypedCli({
  type: "protocol",
  label: "Protocol",
  emoji: "📡",
  injectMarker: "PROTOCOL",
});

await main(process.argv.slice(2));
