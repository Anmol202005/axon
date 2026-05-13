import React from "react";
import os from "node:os";
import { Box, Text } from "ink";

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

// Gentle cyan → lavender gradient down the rows
const LOGO_COLORS = [
  "#5ff7ff",
  "#5fd7ff",
  "#5fafff",
  "#5f87ff",
  "#af87ff",
  "#d787ff",
];

function prettyPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

export function Logo() {
  return (
    <Box flexDirection="column">
      {LOGO.map((line, i) => (
        <Text key={i} color={LOGO_COLORS[i]} bold>
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
        <Text color="gray">a terminal coding agent — type </Text>
        <Text color="cyan">/help</Text>
        <Text color="gray"> for commands</Text>
      </Box>
      <Box flexDirection="column">
        <Box>
          <Text color="cyan">◆ </Text>
          <Text color="gray">workspace  </Text>
          <Text>{cwd}</Text>
        </Box>
        <Box>
          <Text color="cyan">◆ </Text>
          <Text color="gray">model      </Text>
          <Text>{model}</Text>
        </Box>
        <Box>
          <Text color="cyan">◆ </Text>
          <Text color="gray">shortcuts  </Text>
          <Text dimColor>↵ send · ctrl-c quit</Text>
        </Box>
      </Box>
    </Box>
  );
}
