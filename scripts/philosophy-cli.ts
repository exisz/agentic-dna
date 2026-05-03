#!/usr/bin/env node
/**
 * DNA Philosophy CLI — thin wrapper.
 *
 * All philosophy entries are mesh nodes (dna://philosophy/<slug>). This file
 * is a 10-line forwarder to the generic typed-CLI factory.
 */
import { makeTypedCli } from "../lib/typed-cli.ts";

const main = makeTypedCli({
  type: "philosophy",
  label: "Philosophy",
  emoji: "🧬",
  injectMarker: "DNA",
});

await main(process.argv.slice(2));
