#!/usr/bin/env node
/**
 * DNA Convention CLI — thin wrapper.
 *
 * All convention entries are mesh nodes (dna://convention/<slug>), including
 * workspace-local ones discovered via SCAN_ROOTS. This file is a forwarder
 * to the generic typed-CLI factory.
 *
 * Note: the legacy --scope global|local|all flag is gone. The mesh already
 * merges global + local; if you need the distinction, use `dna show <id>`
 * to see the source path.
 */
import { makeTypedCli } from "../lib/typed-cli.ts";

const main = makeTypedCli({
  type: "convention",
  label: "Convention",
  emoji: "📏",
  injectMarker: "CONVENTION",
});

await main(process.argv.slice(2));
