import { afterAll } from "bun:test";
import { removeScratchRoot } from "./harness";

afterAll(removeScratchRoot);
