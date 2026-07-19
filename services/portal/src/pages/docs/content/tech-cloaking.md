# Cloaking - Private Memory for Cloud Models

Use frontier cloud models on your knowledge graph without ever showing them who your people, customers, or amounts actually are.

## What it does

Cloaking is an **opt-in mode set per knowledge graph**, with three positions: **Open**, **Cloaked**, and **Local-only**. In Open mode a graph behaves as normal - any connected provider, cloud or local, sees the data as-is. In **Cloaked** mode, entities and other identifying details are **pseudonymized before any cloud model ever sees them**: the model reasons over a stand-in like "Person-7" or "Company-3," never the real name, address, or amount, and GCTRL un-cloaks the answer back to real identities **locally**, after the cloud round trip is done. **Local-only** mode is the strictest setting: that graph is never sent to a cloud model at all, cloaked or otherwise - only local inference ever touches it.

## Why it matters / USP

Frontier cloud models are frequently the best available reasoning engines, and plenty of regulated organizations are told to avoid them entirely because of what leaves the building in the prompt. Cloaking is built to close that gap honestly: it lets a cloud model contribute its reasoning quality to a query while the actual identities, customer names, and figures underneath stay pseudonymized at the boundary. This is **pseudonymization**, not some form of homomorphic magic where the model reasons over untouched secrets - the cloud provider still receives a prompt, just one built from stand-ins instead of real identities, and the real values are substituted back in on your side.

That framing matters for compliance conversations: it is a concrete, explainable DSGVO-aligned control - "here is exactly what leaves, and it isn't your identities" - rather than a black-box promise. Combined with Local-only mode for the graphs that should never touch a cloud provider under any circumstance, Cloaking gives an organization a genuine dial between "best available model" and "nothing leaves ever," set per graph rather than as an all-or-nothing platform choice.

## How it fits

Cloaking applies wherever a cloud provider is in the path - generation for Talk-to-Graph answers, or any cloud-backed step in the pipeline - and composes with the [classification](tech-classification.md) already on the data: a record's clearance still governs who can ask about it in the first place, cloaked or not.

## In practice

An HR team wants a frontier cloud model's help reasoning over sensitive personnel records. Set the compilation to Cloaked: the model sees "Employee-4 reported to Manager-2 starting Cloaked-Date," produces its answer over those stand-ins, and GCTRL substitutes the real names and date back in before showing the result - the cloud provider never saw an actual employee's identity.

## See also

[Classification & Access Control](tech-classification.md) · [Sovereign & On-Prem](tech-sovereign.md) · [Compliance & Data Sovereignty](compliance.md)
