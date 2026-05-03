#!/usr/bin/env node
/**
 * DNA Flow CLI — thin wrapper.
 *
 * All flow entries are mesh nodes (dna://flow/<slug>). This file is a
 * forwarder to the generic typed-CLI factory.
 */
import { makeTypedCli } from "../lib/typed-cli.ts";

const main = makeTypedCli({
  type: "flow",
  label: "Flow",
  emoji: "🌊",
  injectMarker: "FLOW",
});

await main(process.argv.slice(2));
