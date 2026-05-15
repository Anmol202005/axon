import React from "react";
import os from "node:os";
import { Box, Text } from "ink";
import { Theme } from "./theme.js";

// ===========================================================================
// Logo + welcome banner shown once at startup
// ===========================================================================

const LOGO = [
  " █████╗ ██╗  ██╗  ██████╗  ███╗   ██╗",
  "██╔══██╗╚██╗██╔╝ ██╔═══██╗ ████╗  ██║",
  "███████║ ╚███╔╝  ██║   ██║ ██╔██╗ ██║",
  "██╔══██║ ██╔██╗  ██║   ██║ ██║╚██╗██║",
  "██║  ██║██╔╝ ██╗ ╚██████╔╝ ██║ ╚████║",
  "╚═╝  ╚═╝╚═╝  ╚═╝  ╚═════╝  ╚═╝  ╚═══╝",
];

function prettyPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

export function Logo() {
  return (
    <Box flexDirection="column">
      {LOGO.map((line, i) => (
        <Text key={i} bold>
          {line}
        </Text>
      ))}
    </Box>
  );
}

export function Welcome() {
  const cwd = prettyPath(process.cwd());
  const model = process.env.AI_MODEL || "(default)";
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Logo />
      <Box marginTop={1} marginBottom={1}>
        <Text color={Theme.muted}>a terminal coding agent — type </Text>
        <Text bold>/help</Text>
        <Text color={Theme.muted}> for commands</Text>
      </Box>
      <Box flexDirection="column">
        <Box>
          <Text dimColor>◇ </Text>
          <Text color={Theme.muted}>workspace  </Text>
          <Text>{cwd}</Text>
        </Box>
        <Box>
          <Text dimColor>◇ </Text>
          <Text color={Theme.muted}>model      </Text>
          <Text>{model}</Text>
        </Box>
        <Box>
          <Text dimColor>◇ </Text>
          <Text color={Theme.muted}>shortcuts  </Text>
          <Text dimColor>↵ send · ctrl-c quit</Text>
        </Box>
      </Box>
    </Box>
  );
}
