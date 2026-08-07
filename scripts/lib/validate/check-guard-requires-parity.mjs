#!/usr/bin/env node
/**
 * Validate the required-export contract of `armGuard()` head fallbacks.
 *
 * A head fallback can execute either the working-tree module or the committed
 * HEAD copy. This check keeps the three surfaces in lockstep: the static
 * `requires` array, the namespace members used by the hook, and callable named
 * exports available in both module versions.
 *
 * Import-safety: importing this module only exposes the inspector and runner;
 * the CLI path is guarded at the bottom of the file.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';

const HOOKS_RELATIVE_DIR = 'hooks';
const MODULE_RELATIVE_PREFIX = 'scripts/lib';
const MODULE_NAMESPACE_NAME = 'modules';
const GIT_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TZ',
]);

/**
 * @typedef {{
 *   kind: string,
 *   hook: string,
 *   line: number,
 *   contract: string,
 *   message: string,
 * }} Finding
 */

/**
 * @typedef {{
 *   hook: string,
 *   line: number,
 *   namespace: string,
 *   binding: string | null,
 *   specifier: string,
 *   requires: string[],
 *   uses: string[],
 * }} GuardContract
 */

/**
 * Recursively collect hook modules in deterministic path order.
 *
 * Symlinked hook entries are returned separately and are never followed. A
 * symlink is an operator-controlled path escape at exactly the boundary this
 * validator is meant to census, so silently treating it as "not a hook" would
 * make the check incomplete.
 *
 * @param {string} directory
 * @returns {{files: string[], symlinks: string[]}}
 */
function collectHookFiles(directory) {
  if (!existsSync(directory)) return { files: [], symlinks: [] };
  const entries = readdirSync(directory, { withFileTypes: true });
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const symlinks = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      symlinks.push(fullPath);
    } else if (entry.isDirectory()) {
      const nested = collectHookFiles(fullPath);
      files.push(...nested.files);
      symlinks.push(...nested.symlinks);
    } else if (entry.isFile() && path.extname(entry.name) === '.mjs') {
      files.push(fullPath);
    }
  }
  return { files: files.sort(), symlinks: symlinks.sort() };
}

/**
 * Parse a source module with the same syntax family used by this repository.
 *
 * @param {string} source
 * @param {string} filename
 * @returns {import('@babel/parser').ParseResult<import('@babel/types').File>}
 */
function parseModule(source, filename) {
  return parse(source, {
    sourceType: 'module',
    sourceFilename: filename,
    errorRecovery: false,
    plugins: ['topLevelAwait', 'importMeta'],
  });
}

/**
 * Walk Babel's AST without depending on a second AST package. Babel nodes have
 * no parent links, and location/token metadata is deliberately not traversed.
 *
 * @param {unknown} value
 * @param {(node: any, parent: any, key: string | number | null) => void} visit
 * @param {any} [parent]
 * @param {string | number | null} [key]
 * @param {Set<object>} [seen]
 */
function walk(value, visit, parent = null, key = null, seen = new Set()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (typeof value.type === 'string') visit(value, parent, key);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) walk(value[i], visit, parent, i, seen);
    return;
  }

  for (const [childKey, child] of Object.entries(value)) {
    if (childKey === 'loc' || childKey === 'start' || childKey === 'end' || childKey === 'extra') continue;
    if (childKey === 'tokens' || childKey === 'comments' || childKey === 'errors') continue;
    if (child && typeof child === 'object') walk(child, visit, value, childKey, seen);
  }
}

/**
 * Return a static property name, or null when the property is not a literal
 * identifier/string. Computed properties are handled separately and rejected.
 *
 * @param {any} node
 * @returns {string | null}
 */
function staticName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'StringLiteral') return node.value;
  return null;
}

/**
 * @param {any} node
 * @returns {boolean}
 */
function isGuardLoaderImport(node) {
  const expression = node?.type === 'AwaitExpression' ? node.argument : node;
  return Boolean(
    expression?.type === 'CallExpression' &&
      expression.callee?.type === 'Import' &&
      expression.arguments.length === 1 &&
      expression.arguments[0]?.type === 'StringLiteral' &&
      expression.arguments[0].value === './_lib/guard-source-loader.mjs',
  );
}

/**
 * @param {any} property
 * @returns {{key: string, local: any} | null}
 */
function readImportProperty(property) {
  if (!property || property.type !== 'ObjectProperty' || property.computed) return null;
  const key = staticName(property.key);
  if (key === null || property.value?.type !== 'Identifier') return null;
  return { key, local: property.value };
}

/**
 * Find the only callee provenance this validator trusts: an unaliased named
 * `armGuard` binding imported from the guard source loader. Every other route is
 * reported instead of being omitted from the contract census.
 *
 * @param {any} ast
 * @returns {{validImportNodes: Set<object>, loaderImportNodes: Set<object>, armGuardLikeNames: Set<string>, foreignBindingNodes: Set<object>, invalidImportNames: Set<string>}}
 */
function findArmGuardProvenance(ast) {
  const validImportNodes = new Set();
  const loaderImportNodes = new Set();
  const invalidImportNames = new Set();
  const loaderNames = new Set();
  const armGuardMemberNames = new Set();
  const aliasEdges = new Map();

  walk(ast, (node) => {
    if (node.type === 'ImportDeclaration' && node.source?.value === './_lib/guard-source-loader.mjs') {
      for (const specifier of node.specifiers) {
        if (specifier.type === 'ImportSpecifier') {
          const imported = staticName(specifier.imported);
          const local = specifier.local;
          if (imported === 'armGuard' && local?.type === 'Identifier') {
            loaderImportNodes.add(specifier);
            if (local.name === 'armGuard') validImportNodes.add(local);
            else invalidImportNames.add(local.name);
          }
        } else if (specifier.local?.type === 'Identifier') {
          loaderNames.add(specifier.local.name);
        }
      }
    }

    if (node.type !== 'VariableDeclarator') return;
    if (isGuardLoaderImport(node.init)) {
      loaderImportNodes.add(node);
      if (node.id?.type === 'Identifier') {
        loaderNames.add(node.id.name);
      } else if (node.id?.type === 'ObjectPattern') {
        for (const property of node.id.properties) {
          const imported = readImportProperty(property);
          if (!imported) continue;
          if (imported.key === 'armGuard') {
            if (imported.local.name === 'armGuard') validImportNodes.add(imported.local);
            else invalidImportNames.add(imported.local.name);
          }
        }
      }
    }

    if (node.id?.type === 'Identifier' && node.init?.type === 'Identifier') {
      aliasEdges.set(node.id.name, node.init.name);
    }
    if (
      node.id?.type === 'Identifier' &&
      isMemberExpression(node.init) &&
      node.init.object?.type === 'Identifier' &&
      staticName(node.init.property) === 'armGuard'
    ) {
      aliasEdges.set(node.id.name, node.init.object.name);
      if (loaderNames.has(node.init.object.name)) armGuardMemberNames.add(node.id.name);
    }

    if (
      node.type === 'AssignmentExpression' &&
      node.left?.type === 'Identifier' &&
      node.right?.type === 'Identifier'
    ) {
      aliasEdges.set(node.left.name, node.right.name);
    }
    if (
      node.type === 'AssignmentExpression' &&
      node.left?.type === 'Identifier' &&
      isMemberExpression(node.right) &&
      node.right.object?.type === 'Identifier' &&
      staticName(node.right.property) === 'armGuard'
    ) {
      aliasEdges.set(node.left.name, node.right.object.name);
      if (loaderNames.has(node.right.object.name)) armGuardMemberNames.add(node.left.name);
    }
  });

  const armGuardLikeNames = new Set(['armGuard', ...invalidImportNames, ...armGuardMemberNames]);
  for (const [local, source] of aliasEdges) {
    if (source === 'armGuard' || armGuardLikeNames.has(source)) armGuardLikeNames.add(local);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [local, source] of aliasEdges) {
      if (!armGuardLikeNames.has(source) || armGuardLikeNames.has(local)) continue;
      armGuardLikeNames.add(local);
      changed = true;
    }
  }

  const foreignBindingNodes = new Set();
  const recordForeign = (binding) => {
    if (binding?.type === 'Identifier' && binding.name === 'armGuard' && !validImportNodes.has(binding)) {
      foreignBindingNodes.add(binding);
    }
  };
  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator') {
      const bindings = new Set();
      collectBindingIdentifiers(node.id, bindings);
      for (const binding of bindings) recordForeign(binding);
    }
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression' ||
      node.type === 'ObjectMethod' ||
      node.type === 'ClassMethod' ||
      node.type === 'ClassDeclaration' ||
      node.type === 'ClassExpression'
    ) {
      recordForeign(node.id);
      for (const parameter of node.params || []) {
        const bindings = new Set();
        collectBindingIdentifiers(parameter, bindings);
        for (const binding of bindings) recordForeign(binding);
      }
    }
    if (node.type === 'CatchClause') {
      const bindings = new Set();
      collectBindingIdentifiers(node.param, bindings);
      for (const binding of bindings) recordForeign(binding);
    }
    if (
      (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier') &&
      node.local?.type === 'Identifier'
    ) {
      recordForeign(node.local);
    }
  });

  return { validImportNodes, loaderImportNodes, armGuardLikeNames, foreignBindingNodes, invalidImportNames };
}

/**
 * @param {any} ast
 * @returns {{validCalls: any[], invalidCalls: any[]}}
 */
function findArmGuardCalls(ast) {
  const provenance = findArmGuardProvenance(ast);
  const validCalls = [];
  const invalidCalls = [];
  const seenInvalid = new Set();
  const hasValidImport = provenance.validImportNodes.size > 0;
  const validDirectCall = (node) =>
    node?.type === 'CallExpression' &&
    node.callee?.type === 'Identifier' &&
    node.callee.name === 'armGuard' &&
    hasValidImport &&
    provenance.foreignBindingNodes.size === 0;
  const reportInvalid = (node) => {
    if (!seenInvalid.has(node)) {
      seenInvalid.add(node);
      invalidCalls.push(node);
    }
  };

  walk(ast, (node, parent, key) => {
    if (node.type === 'CallExpression') {
      if (validDirectCall(node)) {
        validCalls.push(node);
        return;
      }

      const callee = node.callee;
      if (
        callee?.type === 'Identifier' &&
        (callee.name === 'armGuard' || provenance.armGuardLikeNames.has(callee.name))
      ) {
        reportInvalid(node);
        return;
      }
      if (
        isMemberExpression(callee) &&
        ((callee.object?.type === 'Identifier' && provenance.armGuardLikeNames.has(callee.object.name)) ||
          staticName(callee.property) === 'armGuard')
      ) {
        reportInvalid(node);
      }
    }

    if (node.type !== 'Identifier' || !provenance.armGuardLikeNames.has(node.name)) return;
    if (provenance.validImportNodes.has(node)) return;
    if (isBindingIdentifier(node, parent, key, provenance.validImportNodes)) return;

    if (
      (parent?.type === 'CallExpression' || parent?.type === 'OptionalCallExpression') &&
      key === 'callee'
    ) {
      if (!validDirectCall(parent)) reportInvalid(parent);
      return;
    }
    reportInvalid(node);
  });

  if (provenance.loaderImportNodes.size > 0 && validCalls.length === 0 && invalidCalls.length === 0) {
    for (const importNode of provenance.loaderImportNodes) reportInvalid(importNode);
  }

  return { validCalls, invalidCalls };
}

/**
 * @param {any} node
 * @returns {number}
 */
function lineOf(node) {
  return node?.loc?.start?.line ?? 1;
}

/**
 * @param {string} pluginRoot
 * @param {string} hookPath
 * @param {string} contract
 * @param {string} kind
 * @param {string} message
 * @param {any} node
 * @returns {Finding}
 */
function finding(pluginRoot, hookPath, contract, kind, message, node) {
  return {
    kind,
    hook: path.relative(pluginRoot, hookPath),
    line: lineOf(node),
    contract,
    message,
  };
}

/**
 * @param {any} expression
 * @param {string} expectedProperty
 * @returns {boolean}
 */
function isDirectModulesMember(expression, expectedProperty) {
  return Boolean(
    expression &&
      (expression.type === 'MemberExpression' || expression.type === 'OptionalMemberExpression') &&
      !expression.computed &&
      expression.object?.type === 'Identifier' &&
      expression.object.name === MODULE_NAMESPACE_NAME &&
      staticName(expression.property) === expectedProperty,
  );
}

/**
 * @param {any} node
 * @returns {boolean}
 */
function isMemberExpression(node) {
  return node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression';
}

/**
 * Get a static object property's value while rejecting duplicate names and
 * non-object property forms. The caller supplies the finding callback because
 * location and contract context belong to the hook, not this helper.
 *
 * @param {any} objectNode
 * @param {(kind: string, message: string, node: any) => void} report
 * @returns {Map<string, any> | null}
 */
function readStaticObject(objectNode, report) {
  if (!objectNode || objectNode.type !== 'ObjectExpression') {
    report('dynamic-contract', 'armGuard contract must be an inline object literal', objectNode);
    return null;
  }

  const properties = new Map();
  for (const property of objectNode.properties) {
    if (property.type === 'SpreadElement') {
      report('dynamic-contract', 'spread properties are unsupported in armGuard contracts', property);
      continue;
    }
    if (property.type !== 'ObjectProperty' || property.computed) {
      report('dynamic-contract', 'computed or indirect properties are unsupported in armGuard contracts', property);
      continue;
    }
    const name = staticName(property.key);
    if (name === null) {
      report('dynamic-contract', 'armGuard contract property names must be literal identifiers or strings', property);
      continue;
    }
    if (properties.has(name)) {
      report('dynamic-contract', `duplicate armGuard contract property: ${name}`, property);
      continue;
    }
    properties.set(name, property.value);
  }
  return properties;
}

/**
 * @param {any} value
 * @returns {{segments: string[]} | {error: string}}
 */
function readSpecifier(value) {
  if (!value || value.type !== 'CallExpression' || value.callee?.type !== 'Identifier' || value.callee.name !== 'lib') {
    return { error: 'specifier must be a direct lib(<literal path segments>) call' };
  }
  if (value.arguments.length === 0) return { error: 'specifier lib() call must contain at least one path segment' };
  const segments = [];
  for (const argument of value.arguments) {
    if (argument.type !== 'StringLiteral' || argument.value.length === 0 || path.isAbsolute(argument.value)) {
      return { error: 'specifier lib() arguments must be nonempty relative literal path segments' };
    }
    segments.push(argument.value);
  }
  return { segments };
}

/**
 * @param {any} value
 * @returns {{requires: string[]} | {error: string}}
 */
function readRequires(value) {
  if (!value || value.type !== 'ArrayExpression') {
    return { error: 'requires must be a nonempty literal-string array' };
  }
  if (value.elements.length === 0) return { error: 'requires must not be empty' };
  const requires = [];
  const unique = new Set();
  for (const element of value.elements) {
    if (!element || element.type !== 'StringLiteral' || element.value.length === 0) {
      return { error: 'requires entries must be nonempty literal strings' };
    }
    if (unique.has(element.value)) return { error: `requires contains duplicate export: ${element.value}` };
    unique.add(element.value);
    requires.push(element.value);
  }
  return { requires };
}

/**
 * Find direct assignments of `modules.<contractName>` to a local identifier.
 * The `modules` object is trusted only when it is destructured directly from the
 * exact `armGuard()` call being inspected. Any other binding with that name
 * makes the contract ambiguous and is therefore rejected.
 *
 * @param {any} ast
 * @param {string} contractName
 * @param {any} armGuardCall
 * @returns {{aliases: string[], bindingNodes: Set<object>, modulesBindingNodes: Set<object>, shadowedModulesNodes: any[]}}
 */
function findDirectBindings(ast, contractName, armGuardCall) {
  const aliases = new Set();
  const bindingNodes = new Set();
  const modulesBindingNodes = new Set();
  const allModulesBindings = new Set();

  const recordModulesBinding = (binding) => {
    if (binding?.type === 'Identifier' && binding.name === MODULE_NAMESPACE_NAME) {
      allModulesBindings.add(binding);
    }
  };
  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator') {
      const bindings = new Set();
      collectBindingIdentifiers(node.id, bindings);
      for (const binding of bindings) recordModulesBinding(binding);

      if (
        node.init?.type === 'AwaitExpression' &&
        node.init.argument === armGuardCall &&
        node.id?.type === 'ObjectPattern'
      ) {
        for (const property of node.id.properties) {
          const imported = readImportProperty(property);
          if (imported?.key === MODULE_NAMESPACE_NAME && imported.local.name === MODULE_NAMESPACE_NAME) {
            modulesBindingNodes.add(imported.local);
          }
        }
      }
    }
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression' ||
      node.type === 'ObjectMethod' ||
      node.type === 'ClassMethod' ||
      node.type === 'ClassDeclaration' ||
      node.type === 'ClassExpression'
    ) {
      recordModulesBinding(node.id);
      for (const parameter of node.params || []) {
        const bindings = new Set();
        collectBindingIdentifiers(parameter, bindings);
        for (const binding of bindings) recordModulesBinding(binding);
      }
    }
    if (node.type === 'CatchClause') {
      const bindings = new Set();
      collectBindingIdentifiers(node.param, bindings);
      for (const binding of bindings) recordModulesBinding(binding);
    }
    if (
      (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier') &&
      node.local?.type === 'Identifier'
    ) {
      recordModulesBinding(node.local);
    }
    if (
      node.type === 'AssignmentExpression' &&
      node.left?.type === 'Identifier' &&
      node.left.name === MODULE_NAMESPACE_NAME
    ) {
      allModulesBindings.add(node.left);
    }
  });

  const shadowedModulesNodes = [...allModulesBindings].filter(
    (binding) => !modulesBindingNodes.has(binding),
  );
  const modulesTrusted = modulesBindingNodes.size > 0 && shadowedModulesNodes.length === 0;
  if (!modulesTrusted) {
    return {
      aliases: [],
      bindingNodes,
      modulesBindingNodes,
      shadowedModulesNodes,
    };
  }

  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
      if (isDirectModulesMember(node.init, contractName)) {
        aliases.add(node.id.name);
        bindingNodes.add(node.id);
      }
    }
    if (
      node.type === 'AssignmentExpression' &&
      node.left?.type === 'Identifier' &&
      isDirectModulesMember(node.right, contractName)
    ) {
      aliases.add(node.left.name);
      bindingNodes.add(node.left);
    }
  });
  return {
    aliases: [...aliases].sort(),
    bindingNodes,
    modulesBindingNodes,
    shadowedModulesNodes,
  };
}

/**
 * Collect identifiers introduced by a binding pattern.
 *
 * @param {any} pattern
 * @param {Set<object>} output
 */
function collectBindingIdentifiers(pattern, output) {
  if (!pattern) return;
  if (pattern.type === 'Identifier') {
    output.add(pattern);
    return;
  }
  if (pattern.type === 'RestElement' || pattern.type === 'AssignmentPattern') {
    collectBindingIdentifiers(pattern.argument || pattern.left, output);
    return;
  }
  if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements) collectBindingIdentifiers(element, output);
    return;
  }
  if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      if (property.type === 'RestElement') {
        collectBindingIdentifiers(property.argument, output);
      } else if (property.type === 'ObjectProperty') {
        collectBindingIdentifiers(property.value, output);
      }
    }
  }
}

/**
 * Top-level declarations are the one non-direct binding form allowed for the
 * current hook shape (`let blocker; blocker = modules.blocker`). Nested
 * declarations with the same name are not safe to classify by identifier text.
 *
 * @param {any} ast
 * @returns {Set<object>}
 */
function findTopLevelBindingNodes(ast) {
  const topLevelBindings = new Set();
  for (const statement of ast.program.body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declaration of statement.declarations) {
      collectBindingIdentifiers(declaration.id, topLevelBindings);
    }
  }
  return topLevelBindings;
}

/**
 * @param {any} node
 * @param {any} parent
 * @param {string | number | null} key
 * @param {Set<object>} directBindingNodes
 * @returns {boolean}
 */
function isBindingIdentifier(node, parent, key, directBindingNodes) {
  if (node.type !== 'Identifier') return false;
  if (directBindingNodes.has(node)) return true;
  if (parent?.type === 'VariableDeclarator' && key === 'id') return true;
  if (
    (parent?.type === 'FunctionDeclaration' || parent?.type === 'FunctionExpression' || parent?.type === 'ClassDeclaration' || parent?.type === 'ClassExpression') &&
    (key === 'id' || key === 'params')
  ) return true;
  if (parent?.type === 'CatchClause' && key === 'param') return true;
  if (parent?.type === 'ImportSpecifier' || parent?.type === 'ImportDefaultSpecifier' || parent?.type === 'ImportNamespaceSpecifier') return true;
  if (parent?.type === 'RestElement' && key === 'argument') return true;
  if (parent?.type === 'ObjectProperty' && key === 'key' && !parent.computed) return true;
  if (isMemberExpression(parent) && key === 'property' && !parent.computed) return true;
  if ((parent?.type === 'ObjectMethod' || parent?.type === 'ClassMethod') && key === 'key' && !parent.computed) return true;
  return false;
}

/**
 * Compare direct namespace-member use with the declared requires set.
 *
 * @param {any} ast
 * @param {string[]} aliases
 * @param {Set<object>} directBindingNodes
 * @returns {{uses: string[], dynamicNodes: any[], indirectNodes: any[], shadowedNodes: any[]}}
 */
function findNamespaceUses(ast, aliases, directBindingNodes) {
  const aliasSet = new Set(aliases);
  const topLevelBindingNodes = findTopLevelBindingNodes(ast);
  const uses = new Set();
  const dynamicNodes = [];
  const indirectNodes = [];
  const shadowedNodes = [];
  const shadowedSet = new Set();
  const addShadowed = (node) => {
    if (!node || !aliasSet.has(node.name) || directBindingNodes.has(node) || topLevelBindingNodes.has(node)) return;
    if (!shadowedSet.has(node)) {
      shadowedSet.add(node);
      shadowedNodes.push(node);
    }
  };

  walk(ast, (node, parent, key) => {
    if (node.type === 'VariableDeclarator') {
      const bindings = new Set();
      collectBindingIdentifiers(node.id, bindings);
      for (const binding of bindings) addShadowed(binding);
    }
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression' ||
      node.type === 'ObjectMethod' ||
      node.type === 'ClassMethod'
    ) {
      addShadowed(node.id);
      for (const parameter of node.params || []) {
        const bindings = new Set();
        collectBindingIdentifiers(parameter, bindings);
        for (const binding of bindings) addShadowed(binding);
      }
    }
    if (node.type === 'CatchClause') {
      const bindings = new Set();
      collectBindingIdentifiers(node.param, bindings);
      for (const binding of bindings) addShadowed(binding);
    }
    if (
      (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier') &&
      node.local?.type === 'Identifier'
    ) {
      addShadowed(node.local);
    }

    if (isMemberExpression(node) && node.object?.type === 'Identifier' && aliasSet.has(node.object.name)) {
      if (node.computed || staticName(node.property) === null) {
        dynamicNodes.push(node);
      } else {
        uses.add(staticName(node.property));
      }
      return;
    }

    if (node.type !== 'Identifier' || !aliasSet.has(node.name)) return;
    if (shadowedSet.has(node)) return;
    if (isBindingIdentifier(node, parent, key, directBindingNodes)) return;
    if (isMemberExpression(parent) && key === 'object' && !parent.computed) return;
    indirectNodes.push(node);
  });

  return {
    uses: [...uses].sort(),
    dynamicNodes,
    indirectNodes,
    shadowedNodes,
  };
}

/**
 * Classify the statically visible value of a local binding.
 *
 * @param {any} expression
 * @returns {{kind: 'function' | 'non-function' | 'alias' | 'unknown', name?: string}}
 */
function classifyExpression(expression) {
  if (!expression) return { kind: 'unknown' };
  if (expression.type === 'FunctionExpression' || expression.type === 'ArrowFunctionExpression') return { kind: 'function' };
  if (expression.type === 'Identifier') return { kind: 'alias', name: expression.name };
  return { kind: 'non-function' };
}

/**
 * Resolve named ESM exports, including local export aliases.
 *
 * @param {any} ast
 * @returns {Map<string, 'function' | 'non-function' | 'unknown'>}
 */
function resolveNamedExports(ast) {
  /** @type {Map<string, {kind: 'function' | 'non-function' | 'alias' | 'unknown', name?: string}>} */
  const locals = new Map();
  /** @type {Map<string, string>} */
  const exportedLocals = new Map();

  const recordDeclaration = (declaration) => {
    if (!declaration) return;
    if (declaration.type === 'FunctionDeclaration' && declaration.id) {
      locals.set(declaration.id.name, { kind: 'function' });
      return;
    }
    if (declaration.type === 'ClassDeclaration' && declaration.id) {
      locals.set(declaration.id.name, { kind: 'non-function' });
      return;
    }
    if (declaration.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations) {
        if (declarator.id?.type === 'Identifier') {
          locals.set(declarator.id.name, classifyExpression(declarator.init));
        }
      }
    }
  };

  for (const statement of ast.program.body) {
    if (statement.type === 'ExportNamedDeclaration') {
      recordDeclaration(statement.declaration);
      if (statement.source) {
        for (const specifier of statement.specifiers) {
          const exported = staticName(specifier.exported);
          if (exported) exportedLocals.set(exported, '');
        }
      } else {
        for (const specifier of statement.specifiers) {
          const local = staticName(specifier.local);
          const exported = staticName(specifier.exported);
          if (local && exported) exportedLocals.set(exported, local);
        }
      }
    } else {
      recordDeclaration(statement);
    }
  }

  const resolving = new Set();
  /** @param {string} name */
  const resolveLocal = (name) => {
    if (resolving.has(name)) return 'unknown';
    const local = locals.get(name);
    if (!local) return 'unknown';
    if (local.kind === 'function' || local.kind === 'non-function' || local.kind === 'unknown') return local.kind;
    if (!local.name) return 'unknown';
    resolving.add(name);
    const result = resolveLocal(local.name);
    resolving.delete(name);
    return result;
  };

  const exports = new Map();
  for (const [exported, local] of exportedLocals) {
    exports.set(exported, local ? resolveLocal(local) : 'unknown');
  }
  // `export function foo(){}` and `export const foo = () => {}` have a
  // declaration but no specifier. They are still named exports.
  for (const statement of ast.program.body) {
    if (statement.type !== 'ExportNamedDeclaration' || !statement.declaration) continue;
    const declaration = statement.declaration;
    if (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') {
      if (declaration.id) exports.set(declaration.id.name, resolveLocal(declaration.id.name));
    } else if (declaration.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations) {
        if (declarator.id?.type === 'Identifier') exports.set(declarator.id.name, resolveLocal(declarator.id.name));
      }
    }
  }
  return exports;
}

/**
 * Load and parse both module versions. The cache is per inspection run so a
 * repeated module reference cannot observe different sources mid-check.
 *
 * @param {string} pluginRoot
 * @param {string} modulePath
 * @param {Map<string, {working: any, head: any}>} cache
 * @returns {{working: any, head: any}}
 */
function loadModuleVersions(pluginRoot, modulePath, cache) {
  const relative = path.relative(pluginRoot, modulePath);
  const cached = cache.get(relative);
  if (cached) return cached;

  const workingSource = readFileSync(modulePath, 'utf8');
  const working = parseModule(workingSource, modulePath);
  const gitPath = relative.split(path.sep).join('/');
  const env = {};
  for (const key of GIT_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const result = spawnSync('git', ['show', `HEAD:${gitPath}`], {
    cwd: pluginRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git show HEAD:${gitPath} failed: ${(result.stderr || '').trim() || `exit ${result.status}`}`);
  }
  const head = parseModule(result.stdout, `HEAD:${gitPath}`);
  const versions = { working, head };
  cache.set(relative, versions);
  return versions;
}

/**
 * Inspect all static head-fallback contracts under recursive hooks/*.mjs files.
 *
 * @param {string} pluginRoot
 * @returns {{ok: boolean, summary: {filesScanned: number, contracts: number, requires: number}, contracts: GuardContract[], findings: Finding[], toolError: boolean}}
 */
export function inspectGuardRequiresParity(pluginRoot) {
  const result = {
    ok: false,
    summary: { filesScanned: 0, contracts: 0, requires: 0 },
    contracts: [],
    findings: [],
    toolError: false,
  };

  let hookFiles;
  let symlinkedHookEntries;
  try {
    const collected = collectHookFiles(path.join(pluginRoot, HOOKS_RELATIVE_DIR));
    hookFiles = collected.files;
    symlinkedHookEntries = collected.symlinks;
  } catch (error) {
    result.toolError = true;
    result.findings.push({
      kind: 'tool-error',
      hook: HOOKS_RELATIVE_DIR,
      line: 1,
      contract: '',
      message: `cannot scan hook files: ${error instanceof Error ? error.message : String(error)}`,
    });
    return result;
  }
  result.summary.filesScanned = hookFiles.length + symlinkedHookEntries.length;
  for (const symlinkPath of symlinkedHookEntries) {
    result.findings.push({
      kind: 'symlink-handler',
      hook: path.relative(pluginRoot, symlinkPath),
      line: 1,
      contract: path.relative(pluginRoot, symlinkPath),
      message: 'symlinked hook entries are unsupported; refusing to follow a handler outside the plugin root',
    });
  }

  const moduleCache = new Map();
  for (const hookPath of hookFiles) {
    let ast;
    try {
      ast = parseModule(readFileSync(hookPath, 'utf8'), hookPath);
    } catch (error) {
      result.toolError = true;
      result.findings.push({
        kind: 'tool-error',
        hook: path.relative(pluginRoot, hookPath),
        line: 1,
        contract: '',
        message: `cannot parse hook: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const { validCalls, invalidCalls } = findArmGuardCalls(ast);
    for (const invalidCall of invalidCalls) {
      result.findings.push({
        kind: 'invalid-armguard-provenance',
        hook: path.relative(pluginRoot, hookPath),
        line: lineOf(invalidCall),
        contract: path.relative(pluginRoot, hookPath),
        message: `armGuard call must use the unaliased named import from ./_lib/guard-source-loader.mjs; indirect, shadowed, aliased, or member calls are unsupported`,
      });
    }

    for (const node of validCalls) {
      const contractFindings = [];
      const report = (kind, message, sourceNode) => {
        contractFindings.push(finding(pluginRoot, hookPath, '', kind, message, sourceNode || node));
      };
      const specMap = readStaticObject(node.arguments[0], report);
      if (!specMap) {
        for (const item of contractFindings) result.findings.push(item);
        continue;
      }

      for (const [namespace, specValue] of specMap) {
        if (!specValue || specValue.type !== 'ObjectExpression') {
          report('dynamic-contract', `armGuard spec for ${namespace} must be an inline object literal`, specValue || node);
          continue;
        }
        const specProperties = readStaticObject(specValue, (kind, message, sourceNode) => {
          report(kind, `${namespace}: ${message}`, sourceNode);
        });
        if (!specProperties) continue;

        const headFallback = specProperties.get('headFallback');
        if (headFallback === undefined) continue;
        if (headFallback.type !== 'BooleanLiteral') {
          report('dynamic-contract', `${namespace}: headFallback must be a literal boolean`, headFallback);
          continue;
        }
        if (headFallback.value !== true) continue;

        result.summary.contracts += 1;
        const contractStart = specValue;
        const specifierValue = specProperties.get('specifier');
        const specifier = readSpecifier(specifierValue);
        if ('error' in specifier) {
          report('dynamic-contract', `${namespace}: ${specifier.error}`, specifierValue || contractStart);
          continue;
        }
        const requiresValue = specProperties.get('requires');
        const requires = readRequires(requiresValue);
        if ('error' in requires) {
          report('dynamic-contract', `${namespace}: ${requires.error}`, requiresValue || contractStart);
          continue;
        }
        result.summary.requires += requires.requires.length;

        const modulePath = path.resolve(pluginRoot, MODULE_RELATIVE_PREFIX, ...specifier.segments);
        const moduleRelative = path.relative(pluginRoot, modulePath);
        if (moduleRelative.startsWith('..') || path.isAbsolute(moduleRelative) || !moduleRelative.startsWith(`${MODULE_RELATIVE_PREFIX}${path.sep}`)) {
          report('dynamic-contract', `${namespace}: specifier resolves outside ${MODULE_RELATIVE_PREFIX}`, specifierValue);
          continue;
        }
        if (!existsSync(modulePath) || !statSync(modulePath).isFile()) {
          result.toolError = true;
          report('tool-error', `${namespace}: referenced module does not exist: ${moduleRelative}`, specifierValue);
          continue;
        }

        const { aliases, bindingNodes, shadowedModulesNodes } = findDirectBindings(ast, namespace, node);
        const contract = {
          hook: path.relative(pluginRoot, hookPath),
          line: lineOf(contractStart),
          namespace,
          binding: aliases.length === 1 ? aliases[0] : aliases.length > 1 ? aliases.join(',') : null,
          specifier: moduleRelative,
          requires: [...requires.requires].sort(),
          uses: [],
        };
        result.contracts.push(contract);

        if (aliases.length === 0) {
          report('indirect-contract', `${namespace}: no direct binding from armGuard().modules.${namespace} to a local namespace`, contractStart);
        }
        if (shadowedModulesNodes.length > 0) {
          report('shadowed-binding', `${namespace}: modules must be directly bound from this armGuard() result; unrelated or nested modules bindings are unsupported`, shadowedModulesNodes[0]);
        }
        const namespaceUses = findNamespaceUses(ast, aliases, bindingNodes);
        contract.uses = namespaceUses.uses;
        if (namespaceUses.dynamicNodes.length > 0) {
          report('dynamic-contract', `${namespace}: computed namespace-member use is unsupported`, namespaceUses.dynamicNodes[0]);
        }
        if (namespaceUses.indirectNodes.length > 0) {
          report('indirect-contract', `${namespace}: namespace binding is used indirectly; use direct ${aliases.join(' / ') || `${namespace}`}.<member> access`, namespaceUses.indirectNodes[0]);
        }

        if (namespaceUses.shadowedNodes.length > 0) {
          report('shadowed-binding', `${namespace}: a nested binding shadows the namespace alias; lexical namespace use is unsupported`, namespaceUses.shadowedNodes[0]);
        }

        const requiredSet = new Set(requires.requires);
        for (const required of requires.requires) {
          if (!namespaceUses.uses.includes(required)) {
            report('requires-missing-use', `${namespace}: requires ${required}, but the hook has no direct namespace use`, requiresValue);
          }
        }
        for (const used of namespaceUses.uses) {
          if (!requiredSet.has(used)) {
            report('use-missing-require', `${namespace}: direct namespace use ${used} is absent from requires`, contractStart);
          }
        }

        let versions;
        try {
          versions = loadModuleVersions(pluginRoot, modulePath, moduleCache);
        } catch (error) {
          result.toolError = true;
          report('tool-error', `${namespace}: cannot parse/load working-tree and HEAD module ${moduleRelative}: ${error instanceof Error ? error.message : String(error)}`, specifierValue);
          continue;
        }
        const workingExports = resolveNamedExports(versions.working);
        const headExports = resolveNamedExports(versions.head);
        for (const required of requires.requires) {
          const workingKind = workingExports.get(required);
          const headKind = headExports.get(required);
          if (!workingKind) report('required-export-missing', `${namespace}: required export ${required} is absent from the working-tree module`, requiresValue);
          if (!headKind) report('required-export-missing', `${namespace}: required export ${required} is absent from HEAD module`, requiresValue);
          if (workingKind && workingKind !== 'function') report('required-export-non-function', `${namespace}: required export ${required} is not a statically callable function in the working-tree module`, requiresValue);
          if (headKind && headKind !== 'function') report('required-export-non-function', `${namespace}: required export ${required} is not a statically callable function in HEAD module`, requiresValue);
        }
      }

      for (const item of contractFindings) {
        if (!item.contract) item.contract = path.relative(pluginRoot, hookPath);
        result.findings.push(item);
      }
    }
  }

  result.ok = !result.toolError && result.findings.length === 0;
  return result;
}

/**
 * Run the human-readable validator CLI.
 *
 * @param {string} pluginRoot
 * @returns {number} 0 = pass, 1 = contract violation, 2 = parser/Git/filesystem/tool failure
 */
export function runCheckGuardRequiresParity(pluginRoot) {
  console.log('--- Check: guard requires parity (headFallback contracts) ---');
  const inspection = inspectGuardRequiresParity(pluginRoot);
  if (inspection.ok) {
    console.log(`  PASS: ${inspection.summary.contracts} headFallback contract(s) have exact requires parity (${inspection.summary.requires} required export(s))`);
    console.log('');
    console.log('Results: 1 passed, 0 failed');
    return 0;
  }

  for (const item of inspection.findings) {
    const location = item.hook ? `${item.hook}:${item.line} — ` : '';
    console.log(`  FAIL: ${location}${item.message}`);
  }
  console.log('');
  console.log(`Results: 0 passed, ${inspection.findings.length} failed`);
  return inspection.toolError ? 2 : 1;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const pluginRoot = process.argv[2];
  if (!pluginRoot) {
    console.error('Usage: check-guard-requires-parity.mjs <plugin-root>');
    process.exit(2);
  }
  process.exit(runCheckGuardRequiresParity(path.resolve(pluginRoot)));
}
