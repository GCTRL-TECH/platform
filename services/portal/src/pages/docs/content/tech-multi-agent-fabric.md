# Multi-Agent Fabric

Any agent, any framework, one scoped token - GCTRL is the shared, governed memory layer your whole agent team reads and writes to.

## What it does

GCTRL exposes its knowledge graph and memory tiers over an agent-facing surface that doesn't care which framework is asking. Claude Code, Codex, Cursor, GitHub Copilot, and custom orchestrators built on LangChain or similar stacks can all connect - over MCP, over direct HTTP, or by dropping in an agent skill that teaches the connecting agent when and how to read and write. Each connection authenticates with a single **scoped access token**: pick a clearance ceiling, grant the knowledge bases it may touch, and that token is the agent's entire view of the system.

## Why it matters / USP

Today, every project that wants an AI agent to "remember things" ends up building its own bespoke RAG stack - its own vector store, its own chunking, its own access rules, none of it shared with the next project. GCTRL replaces that pattern with **one governed memory layer** that every agent framework in the organization connects to the same way. An agent's write-back after a task isn't a note that dies with the session - it becomes part of the graph the next agent, on the next task, in a different framework entirely, can read.

Because access is token-scoped the same way it is for humans, this doesn't mean one big undifferentiated pool: different agents and different teams can hold different tokens with different clearances and different granted graphs, so a contractor's automation and your internal agent team can share the same infrastructure without sharing each other's data. The result is a single team brain rather than a shelf of disposable, per-project memories - agent-framework-agnostic by design, and access-controlled by the same engine that governs human queries.

## How it fits

The Multi-Agent Fabric is the consumption edge of the whole pipeline: everything KEX extracted, FUSE unified, and Manage KGs curates is what an agent reads through this surface, filtered by [classification](tech-classification.md) exactly as a human query would be.

## In practice

A team runs Claude Code for engineering, a Codex-based support bot, and an internal LangChain orchestrator for ops - three different frameworks, three different scoped tokens, one shared graph. When the support bot resolves a customer issue and writes the resolution back, the engineering agent can retrieve that context weeks later without anyone having synced the two systems by hand.

## See also

[Classification & Access Control](tech-classification.md) · [Why a Memory Layer](tech-memory-layer.md) · [Agents & MCP](agents-mcp.md)
