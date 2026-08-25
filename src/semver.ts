// Validação simples de versão x.y.z (sem pre-release/build metadata — não
// precisamos disso aqui). Compartilhado entre as rotas que aceitam
// minVersion vindo do cliente (fleet-admin force, api emergency).
export const SEMVER = /^\d+\.\d+\.\d+$/;
