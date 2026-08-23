#!/usr/bin/env node
'use strict';

// Test-only semantic scanner. Acorn is byte-pinned by the Python verifier and
// is never included in the static application build.
const readline = require('readline');
const acorn = require('./vendor/acorn-8.15.0/acorn.js');

function unwrap(node) {
  while (node && (node.type === 'ChainExpression' ||
                  node.type === 'ParenthesizedExpression')) {
    node = node.expression;
  }
  return node;
}

function staticString(node) {
  node = unwrap(node);
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticString(node.left);
    const right = staticString(node.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

function analyze(source) {
  const ast = acorn.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    locations: true,
    preserveParens: true,
    allowHashBang: true,
    allowReturnOutsideFunction: true,
  });
  let nextScopeId = 1;
  let nextBindingId = 1;
  const nodeScopes = new WeakMap();
  const parentNodes = new WeakMap();
  const initializerNodes = new Set();
  const assignmentRhsNodes = new Set();
  const allBindings = [];
  function newScope(parent, type, thisLocal = null) {
    return {id: nextScopeId++, parent, type, thisLocal, bindings: new Map()};
  }
  const programScope = newScope(null, 'program', false);

  function addBinding(scope, name, init, start, kind, hoisted = false,
                      suffix = []) {
    if (!name) return;
    if (!scope.bindings.has(name)) scope.bindings.set(name, []);
    const binding = {
      id: nextBindingId++, scope, name, init, start, kind, hoisted, suffix,
    };
    scope.bindings.get(name).push(binding);
    allBindings.push(binding);
    if (init) initializerNodes.add(init);
  }

  function addPattern(scope, pattern, kind, init = null, start = -1,
                      suffix = []) {
    pattern = unwrap(pattern);
    if (!pattern) return;
    if (pattern.type === 'Identifier') {
      addBinding(scope, pattern.name, init, start, kind,
                 !init && ['param', 'catch', 'function-name'].includes(kind),
                 suffix);
      return;
    }
    if (pattern.type === 'AssignmentPattern') {
      addPattern(scope, pattern.left, kind, init, start, suffix);
      return;
    }
    if (pattern.type === 'RestElement') {
      addPattern(scope, pattern.argument, kind, init, start, suffix);
      return;
    }
    if (pattern.type === 'ArrayPattern') {
      for (let index = 0; index < pattern.elements.length; index += 1) {
        const element = pattern.elements[index];
        const elementInit = init && unwrap(init).type === 'ArrayExpression' ?
          unwrap(init).elements[index] : init;
        const elementSuffix = init && unwrap(init).type === 'ArrayExpression' ?
          suffix : [...suffix, String(index)];
        addPattern(scope, element, kind, elementInit, start, elementSuffix);
      }
      return;
    }
    if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties) {
        if (property.type === 'RestElement') {
          addPattern(scope, property.argument, kind, init, start, suffix);
          continue;
        }
        const key = property.computed ? staticString(property.key) :
          (property.key.type === 'Identifier' ? property.key.name :
            staticString(property.key));
        addPattern(scope, property.value, kind, init, start,
                   property.computed && key === null ?
                     [...suffix, {computed: property.key}] :
                     (key === null ? suffix : [...suffix, key]));
      }
    }
  }

  function variableScope(scope) {
    while (scope.parent && scope.type !== 'function' && scope.type !== 'program') {
      scope = scope.parent;
    }
    return scope;
  }

  function children(node, scope, skip = new Set()) {
    for (const childKey of Object.keys(node)) {
      if (skip.has(childKey) || childKey === 'loc' || childKey === 'start' ||
          childKey === 'end') continue;
      const child = node[childKey];
      if (Array.isArray(child)) {
        for (const item of child) buildScopes(item, scope, node);
      } else if (child && typeof child === 'object' && child.type) {
        buildScopes(child, scope, node);
      }
    }
  }

  function buildFunction(node, outerScope, declaration) {
    nodeScopes.set(node, outerScope);
    const functionScope = newScope(
      outerScope, node.type === 'ArrowFunctionExpression' ? 'arrow' : 'function',
      node.type === 'ArrowFunctionExpression' ? null : true);
    if (!declaration && node.id && node.id.type === 'Identifier') {
      addBinding(functionScope, node.id.name, null, -1, 'function-name', true);
    }
    for (const parameter of node.params) addPattern(functionScope, parameter, 'param');
    for (const parameter of node.params) buildScopes(parameter, functionScope, node);
    if (node.body && node.body.type === 'BlockStatement') {
      nodeScopes.set(node.body, functionScope);
      parentNodes.set(node.body, node);
      for (const statement of node.body.body) buildScopes(statement, functionScope,
                                                           node.body);
    } else {
      buildScopes(node.body, functionScope, node);
    }
  }

  function buildScopes(node, scope, parent = null) {
    if (!node || typeof node !== 'object') return;
    nodeScopes.set(node, scope);
    if (parent) parentNodes.set(node, parent);
    if (node.type === 'Program') {
      for (const statement of node.body) buildScopes(statement, scope, node);
      return;
    }
    if (node.type === 'FunctionDeclaration') {
      if (node.id) addBinding(scope, node.id.name, null, -1,
                              'function-declaration', true);
      buildFunction(node, scope, true);
      return;
    }
    if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      buildFunction(node, scope, false);
      return;
    }
    if (node.type === 'BlockStatement') {
      const blockScope = newScope(scope, 'block');
      nodeScopes.set(node, blockScope);
      for (const statement of node.body) buildScopes(statement, blockScope, node);
      return;
    }
    if (node.type === 'CatchClause') {
      const catchScope = newScope(scope, 'catch');
      nodeScopes.set(node, catchScope);
      addPattern(catchScope, node.param, 'catch');
      buildScopes(node.param, catchScope, node);
      buildScopes(node.body, catchScope, node);
      return;
    }
    if (node.type === 'SwitchStatement') {
      const switchScope = newScope(scope, 'block');
      nodeScopes.set(node, switchScope);
      buildScopes(node.discriminant, scope, node);
      for (const switchCase of node.cases) {
        nodeScopes.set(switchCase, switchScope);
        parentNodes.set(switchCase, node);
        buildScopes(switchCase.test, switchScope, switchCase);
        for (const statement of switchCase.consequent) {
          buildScopes(statement, switchScope, switchCase);
        }
      }
      return;
    }
    if (node.type === 'StaticBlock') {
      const staticScope = newScope(scope, 'block');
      nodeScopes.set(node, staticScope);
      for (const statement of node.body) buildScopes(statement, staticScope, node);
      return;
    }
    if (node.type === 'ForStatement' || node.type === 'ForInStatement' ||
        node.type === 'ForOfStatement') {
      const loopScope = newScope(scope, 'block');
      nodeScopes.set(node, loopScope);
      children(node, loopScope);
      return;
    }
    if (node.type === 'VariableDeclaration') {
      const declarationScope = node.kind === 'var' ? variableScope(scope) : scope;
      for (const declarator of node.declarations) {
        nodeScopes.set(declarator, scope);
        parentNodes.set(declarator, node);
        addPattern(declarationScope, declarator.id, node.kind, declarator.init,
                   declarator.start);
        buildScopes(declarator.id, scope, declarator);
        buildScopes(declarator.init, scope, declarator);
      }
      return;
    }
    if (node.type === 'AssignmentExpression' && node.operator === '=') {
      assignmentRhsNodes.add(node.right);
      let targetScope = scope;
      const targetName = unwrap(node.left) && unwrap(node.left).type === 'Identifier' ?
        unwrap(node.left).name : null;
      if (targetName) {
        for (let current = scope; current; current = current.parent) {
          if (current.bindings.has(targetName)) {
            targetScope = current;
            break;
          }
        }
      } else {
        targetScope = variableScope(scope);
      }
      addPattern(targetScope, node.left, 'assignment', node.right, node.start);
      children(node, scope);
      return;
    }
    if (node.type === 'UpdateExpression') {
      const target = unwrap(node.argument);
      if (target && target.type === 'Identifier') {
        let targetScope = scope;
        for (let current = scope; current; current = current.parent) {
          if (current.bindings.has(target.name)) {
            targetScope = current;
            break;
          }
        }
        addBinding(targetScope, target.name, null, node.start, 'mutation');
      }
      children(node, scope);
      return;
    }
    if (node.type === 'ClassDeclaration' && node.id) {
      addBinding(scope, node.id.name, null, node.start, 'class');
    }
    children(node, scope);
  }
  buildScopes(ast, programScope);
  for (const scope of [programScope]) {
    // Bindings in every scope are already source ordered by the AST traversal.
    void scope;
  }

  function bindingFor(name, position, scope) {
    for (let current = scope; current; current = current.parent) {
      if (!current.bindings.has(name)) continue;
      let selected = null;
      for (const binding of current.bindings.get(name)) {
        if (binding.hoisted || binding.start < position) selected = binding;
      }
      return {found: true, binding: selected};
    }
    return {found: false, binding: null};
  }

  function stableConst(binding) {
    if (!binding || binding.kind !== 'const' || !binding.init ||
        binding.suffix.length) return false;
    const records = binding.scope.bindings.get(binding.name) || [];
    return !records.some(record => record.id !== binding.id &&
      (record.kind === 'assignment' || record.kind === 'mutation'));
  }

  function staticPrimitive(node, seen = new Set()) {
    node = unwrap(node);
    if (!node) return {known: false, value: null};
    if (node.type === 'Literal' &&
        (node.value === null || ['string', 'number', 'boolean'].includes(
          typeof node.value))) {
      return {known: true, value: node.value};
    }
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
      return {known: true, value: node.quasis[0].value.cooked};
    }
    if (node.type === 'SequenceExpression') {
      let result = {known: false, value: null};
      for (const expression of node.expressions) {
        result = staticPrimitive(expression, seen);
        if (!result.known) return result;
      }
      return result;
    }
    if (node.type === 'BinaryExpression' && node.operator === '+') {
      const left = staticPrimitive(node.left, seen);
      const right = staticPrimitive(node.right, seen);
      if (!left.known || !right.known) return {known: false, value: null};
      if (!['string', 'number'].includes(typeof left.value) ||
          !['string', 'number'].includes(typeof right.value)) {
        return {known: false, value: null};
      }
      return {known: true, value: left.value + right.value};
    }
    if (node.type === 'Identifier') {
      const result = bindingFor(node.name, node.start, nodeScopes.get(node));
      if (!result.found || !stableConst(result.binding) ||
          seen.has(result.binding.id)) {
        return {known: false, value: null};
      }
      const nextSeen = new Set(seen);
      nextSeen.add(result.binding.id);
      return staticPrimitive(result.binding.init, nextSeen);
    }
    return {known: false, value: null};
  }

  function staticStringInScope(node, seen = new Set()) {
    const result = staticPrimitive(node, seen);
    return result.known && typeof result.value === 'string' ? result.value : null;
  }

  function resolvedSuffix(binding, seen) {
    const parts = [];
    for (const part of binding.suffix) {
      if (typeof part === 'string') {
        parts.push(part);
        continue;
      }
      const value = part && part.computed ?
        staticStringInScope(part.computed, seen) : null;
      if (value === null) return null;
      parts.push(value);
    }
    return parts;
  }

  function resolvePath(node, seen = new Set()) {
    node = unwrap(node);
    if (!node) return null;
    if (node.type === 'SequenceExpression') {
      if (!node.expressions.length) return null;
      const resolved = resolvePath(node.expressions[node.expressions.length - 1], seen);
      return resolved ? {...resolved, indirect: true} : null;
    }
    if (node.type === 'ThisExpression') {
      for (let scope = nodeScopes.get(node); scope; scope = scope.parent) {
        if (scope.thisLocal === true) {
          return {path: 'this', local: true, indirect: false};
        }
        if (scope.type === 'program') {
          return {path: 'globalThis', local: false, indirect: false};
        }
      }
      return null;
    }
    if (node.type === 'Identifier') {
      const result = bindingFor(node.name, node.start, nodeScopes.get(node));
      if (!result.found) return {path: node.name, local: false, indirect: false};
      const binding = result.binding;
      if (!binding) return null;
      if (!binding.init) return {path: node.name, local: true, indirect: false};
      if (seen.has(binding.id)) return null;
      const nextSeen = new Set(seen);
      nextSeen.add(binding.id);
      const resolved = resolvePath(binding.init, nextSeen);
      if (!resolved) return null;
      const suffix = resolvedSuffix(binding, nextSeen);
      if (suffix === null) return null;
      return {
        path: suffix.length ? `${resolved.path}.${suffix.join('.')}` : resolved.path,
        local: resolved.local,
        indirect: true,
        unresolved: Boolean(resolved.unresolved),
        receiver: resolved.receiver,
      };
    }
    if (node.type === 'MemberExpression') {
      const object = resolvePath(node.object, seen);
      const property = node.computed ? staticStringInScope(node.property, seen) :
        (node.property && node.property.type === 'Identifier' ? node.property.name : null);
      if (!object) return null;
      if (property === null) {
        return {path: `${object.path}.[computed]`, local: object.local,
                indirect: true, unresolved: true, receiver: object.path};
      }
      return {path: `${object.path}.${property}`, local: object.local,
              indirect: object.indirect || node.computed,
              unresolved: Boolean(object.unresolved),
              receiver: object.receiver};
    }
    if (node.type === 'CallExpression') {
      const callee = resolvePath(node.callee, seen);
      if (callee && callee.path.endsWith('.bind')) {
        return {...callee, path: callee.path.slice(0, -5), indirect: true};
      }
    }
    return null;
  }

  function sourceText(node) {
    return node ? source.slice(node.start, node.end) : '';
  }

  const accesses = [];
  const calls = [];
  const references = [];
  const derivedSites = [];
  const sensitiveNames = new Set([
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon',
    'localStorage', 'sessionStorage', 'indexedDB', 'eval', 'Function',
    'encodeABI', 'decodeABI', 'encodeQr', 'encodeQrCode', 'encodeQrPayload',
    'buildQrMatrix', 'generateQrCode', 'generateQrMatrix', 'parseFloat',
    'toFixed', 'createElement', 'history', 'navigate',
  ]);

  function sensitiveDerivedPath(path) {
    return path === 'history.pushState' || path === 'history.replaceState' ||
      path === 'history.back' || path === 'globalThis.navigate' ||
      path === 'navigate' || path.startsWith('sessionStorage.') ||
      path.startsWith('localStorage.') || path.startsWith('indexedDB.') ||
      path.startsWith('globalThis.sessionStorage.') ||
      path.startsWith('globalThis.localStorage.') ||
      path.startsWith('globalThis.indexedDB.');
  }

  function isBrowserGlobalAliasPath(path) {
    return /^(?:globalThis|window|self)(?:\.(?:window|self))*$/.test(path);
  }

  function sensitiveComputedReceiver(path) {
    return isBrowserGlobalAliasPath(path) ||
      path === 'history' ||
      path === 'globalThis.history' || path === 'sessionStorage' ||
      path === 'localStorage' || path === 'indexedDB' ||
      path === 'globalThis.sessionStorage' ||
      path === 'globalThis.localStorage' ||
      path === 'globalThis.indexedDB' || path === 'document' ||
      path === 'globalThis.document' || path === 'Number' ||
      path === 'globalThis.Number';
  }

  function unresolvedSensitiveNames(receiver) {
    if (isBrowserGlobalAliasPath(receiver)) {
      return [...sensitiveNames];
    }
    if (receiver === 'history' || receiver === 'globalThis.history') {
      return ['history'];
    }
    if (/^(?:globalThis\.)?(?:sessionStorage|localStorage|indexedDB)$/.test(
      receiver)) {
      return [receiver.split('.').pop()];
    }
    if (receiver === 'document' || receiver === 'globalThis.document') {
      return ['createElement'];
    }
    if (receiver === 'Number' || receiver === 'globalThis.Number') {
      return ['parseFloat', 'toFixed'];
    }
    return [];
  }

  for (const binding of allBindings) {
    if (!binding.init) continue;
    const resolved = resolvePath(binding.init, new Set([binding.id]));
    if (!resolved) continue;
    const suffix = resolvedSuffix(binding, new Set([binding.id]));
    if (suffix === null) continue;
    const path = suffix.length ? `${resolved.path}.${suffix.join('.')}` : resolved.path;
    if (sensitiveDerivedPath(path)) {
      derivedSites.push({path, alias: binding.name, kind: binding.kind,
                         line: binding.init.loc.start.line,
                         local: Boolean(resolved.local)});
    }
  }

  function addExecutable(node) {
    let calleeNode = unwrap(node.callee);
    let resolved = resolvePath(calleeNode);
    let argumentsList = node.arguments;
    let viaCall = false;
    let executionKind = node.type === 'NewExpression' ? 'construct' : 'call';
    if (resolved && resolved.path === 'Reflect.apply' && node.arguments.length >= 3) {
      resolved = resolvePath(node.arguments[0]);
      const array = unwrap(node.arguments[2]);
      argumentsList = array && array.type === 'ArrayExpression' ?
        array.elements : [node.arguments[2]];
      viaCall = true;
      if (resolved) resolved = {...resolved, indirect: true};
    } else if (resolved && resolved.path.endsWith('.bind')) {
      const target = {...resolved, path: resolved.path.slice(0, -5), indirect: true};
      accesses.push({
        callee: target.path,
        arguments: node.arguments.map(sourceText).join(','),
        static_arguments: node.arguments.map(argument =>
          staticStringInScope(argument)),
        called: false,
        line: node.loc.start.line,
        via_call: false,
        local: target.local,
        indirect: true,
        kind: 'bind',
      });
      return;
    } else if (resolved && (resolved.path.endsWith('.call') ||
                            resolved.path.endsWith('.apply'))) {
      const isApply = resolved.path.endsWith('.apply');
      resolved = {...resolved, path: resolved.path.slice(0, isApply ? -6 : -5)};
      if (isApply) {
        const array = unwrap(argumentsList[1]);
        argumentsList = array && array.type === 'ArrayExpression' ?
          array.elements : argumentsList.slice(1);
      } else {
        argumentsList = argumentsList.slice(1);
      }
      viaCall = true;
      resolved.indirect = true;
    }
    if (!resolved) return;
    const argumentsText = argumentsList.map(sourceText).join(',');
    const staticArguments = argumentsList.map(argument =>
      staticStringInScope(argument));
    const site = {
      callee: resolved.path,
      arguments: argumentsText,
      static_arguments: staticArguments,
      called: true,
      line: node.loc.start.line,
      via_call: viaCall,
      local: resolved.local,
      indirect: resolved.indirect,
      kind: executionKind,
    };
    calls.push(site);
    if (resolved.path.includes('.')) accesses.push(site);
  }

  function isInsideInitializer(node) {
    let current = node;
    while (current) {
      if (initializerNodes.has(current)) return true;
      current = parentNodes.get(current);
    }
    return false;
  }

  function isInsideAssignmentRhs(node) {
    let current = node;
    while (current) {
      if (assignmentRhsNodes.has(current)) return true;
      current = parentNodes.get(current);
    }
    return false;
  }

  function isInsideExecutableCallee(node) {
    let current = node;
    while (current) {
      const parent = parentNodes.get(current);
      if (!parent) return false;
      if ((parent.type === 'CallExpression' || parent.type === 'NewExpression') &&
          node.start >= parent.callee.start && node.end <= parent.callee.end) {
        return true;
      }
      current = parent;
    }
    return false;
  }

  function destructuringReceiver(property) {
    const pattern = parentNodes.get(property);
    if (!pattern || pattern.type !== 'ObjectPattern') return null;
    const container = parentNodes.get(pattern);
    if (container && container.type === 'VariableDeclarator' &&
        container.id === pattern) return container.init;
    if (container && container.type === 'AssignmentExpression' &&
        container.left === pattern) return container.right;
    return null;
  }

  function scan(node, parent = null, key = null) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      addExecutable(node);
    }
    if (node.type === 'MemberExpression') {
      const isCallCallee = isInsideExecutableCallee(node);
      const isNestedMember = parent && parent.type === 'MemberExpression' && key === 'object';
      const resolved = resolvePath(node);
      const derivedReference = (isInsideInitializer(node) ||
        isInsideAssignmentRhs(node)) && !isCallCallee;
      const sensitiveParts = resolved ? resolved.path.split('.').filter(name =>
        sensitiveNames.has(name) &&
        !(name === 'Function' &&
          (resolved.path === 'Function.prototype' ||
           resolved.path.startsWith('Function.prototype.')))) : [];
      const unresolvedNames = resolved && resolved.unresolved &&
        sensitiveComputedReceiver(resolved.receiver) ?
        unresolvedSensitiveNames(resolved.receiver) : [];
      for (const sensitiveName of sensitiveParts) {
        references.push({name: sensitiveName, path: resolved.path,
                         line: node.loc.start.line, derived: derivedReference,
                         local: resolved.local});
      }
      for (const sensitiveName of unresolvedNames) {
        references.push({name: sensitiveName, path: resolved.path,
                         line: node.loc.start.line, derived: true,
                         local: resolved.local});
      }
      if (resolved && unresolvedNames.length) {
        derivedSites.push({path: resolved.path, alias: '',
                           kind: 'unresolved-computed',
                           line: node.loc.start.line,
                           local: Boolean(resolved.local)});
      }
      if (resolved && sensitiveParts.length && derivedReference &&
          sensitiveDerivedPath(resolved.path)) {
        derivedSites.push({path: resolved.path, alias: '', kind: 'expression',
                           line: node.loc.start.line,
                           local: Boolean(resolved.local)});
      }
      // Alias bindings are provenance, not an extra API site. Data reads such
      // as history.state remain real accesses even when assigned to a local.
      const suppressedAliasBinding = isInsideInitializer(node) &&
        !(resolved && resolved.path.endsWith('.state'));
      if (!isCallCallee && !isNestedMember && !suppressedAliasBinding) {
        if (resolved) accesses.push({
          callee: resolved.path,
          arguments: null,
          static_arguments: [],
          called: false,
          line: node.loc.start.line,
          via_call: false,
          local: resolved.local,
          indirect: resolved.indirect,
          kind: 'access',
        });
      }
    }
    if (node.type === 'Identifier' && sensitiveNames.has(node.name) &&
        !(parent && parent.type === 'MemberExpression') &&
        !(parent && parent.type === 'Property' && key === 'key')) {
      const resolved = resolvePath(node);
      references.push({name: node.name,
                       path: resolved ? resolved.path : node.name,
                       line: node.loc.start.line,
                       derived: isInsideInitializer(node) ||
                         isInsideAssignmentRhs(node),
                       local: resolved ? resolved.local : true});
    }
    if (node.type === 'Property' && key !== 'value') {
      const receiverNode = destructuringReceiver(node);
      const receiver = receiverNode ? resolvePath(receiverNode) : null;
      const propertyName = node.computed ? staticStringInScope(node.key) :
        (node.key.type === 'Identifier' ? node.key.name : staticString(node.key));
      if (receiver && propertyName && sensitiveNames.has(propertyName)) {
        references.push({name: propertyName,
                         path: `${receiver.path}.${propertyName}`,
                         line: node.loc.start.line, derived: true,
                         local: receiver.local});
      } else if (receiver && propertyName === null &&
                 sensitiveComputedReceiver(receiver.path)) {
        const path = `${receiver.path}.[computed]`;
        for (const sensitiveName of unresolvedSensitiveNames(receiver.path)) {
          references.push({name: sensitiveName, path,
                           line: node.loc.start.line, derived: true,
                           local: receiver.local});
        }
        derivedSites.push({path, alias: '', kind: 'unresolved-pattern-key',
                           line: node.loc.start.line,
                           local: Boolean(receiver.local)});
      }
    }
    for (const childKey of Object.keys(node)) {
      if (childKey === 'loc' || childKey === 'start' || childKey === 'end' ||
          childKey === '__parent') continue;
      const child = node[childKey];
      if (Array.isArray(child)) {
        for (const item of child) scan(item, node, childKey);
      } else if (child && typeof child === 'object' && child.type) {
        scan(child, node, childKey);
      }
    }
  }
  scan(ast);
  return {version: acorn.version, accesses, calls, references,
          derived_sites: derivedSites};
}

const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
input.on('line', line => {
  try {
    const request = JSON.parse(line);
    process.stdout.write(JSON.stringify({ok: true, ...analyze(request.source)}) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ok: false, error: String(error.message || error)}) + '\n');
  }
});
