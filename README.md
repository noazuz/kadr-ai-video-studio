# Kotto Ceramica UK

Custom UK-market build for Kotto Ceramica.

## Stack

- `Symfony 7.4 LTS` + `API Platform`
- `Nuxt 3` + `Vue 3`
- `PostgreSQL`
- `Redis`
- `Symfony Messenger`
- `Typesense`
- `Docker`

## Workspace

- `apps/backend` — Symfony API, admin, integrations, documents
- `apps/storefront` — Nuxt SSR storefront and PWA shell
- `infra` — local Docker, container recipes, operational defaults
- `docs` — project plan, architecture, ownership, operating rules
- `data-mapping` — import specifications, field mapping, migration notes
- `exports` — generated reports and validation outputs
- `scripts` — PowerShell helpers for local setup and development

## Active Workspace

- Preferred development path: `/home/vitalii/projects/kotto-ceramica-uk` inside `Ubuntu-24.04` WSL
- Windows copy `C:\Kotto_ceramica\Kotto Ceramica UK` is now a source mirror / backup, not the preferred runtime path
- Reason: Docker + Symfony + Nuxt run much faster from the Linux filesystem than from a Windows bind-mounted path

## Local Quick Start

1. Open the project from WSL: `\\wsl$\Ubuntu-24.04\home\vitalii\projects\kotto-ceramica-uk`
2. Run `scripts/wsl-stack.ps1 up`
3. Open backend at `http://localhost:8080/api/health`
4. Open storefront at `http://localhost:3000`
5. Open admin at `http://localhost:8080/admin/login`

## Legacy Windows Workflow

If you need the old Windows-rooted flow for reference only:

1. Run `scripts/bootstrap.ps1`
2. Run `scripts/db-bootstrap.ps1`
3. Run `scripts/dev.ps1`
4. Open backend at `http://localhost:8080/api/health`
5. Open storefront at `http://localhost:3000`
6. Open admin at `http://localhost:8080/admin/login`

## Current Status

The repository is scaffolded for phased implementation. The first tranche establishes:

- monorepo structure
- Symfony backend foundation
- Nuxt storefront foundation
- local Docker infrastructure
- project governance and ownership documentation
- initial catalog and identity domain skeleton
- PostgreSQL migration baseline
- demo catalog bootstrap command
- browser admin login and dashboard foundation
- premium collections and product pages in the Nuxt storefront
