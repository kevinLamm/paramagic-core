import { qualifiedDimensionName } from './NamingSystem.js';

export function stackNameVariable(stack, { local = false } = {}) {
  if (!stack) return null;
  const name = local ? 'StackName' : qualifiedDimensionName('StackName', stack.name);
  return {
    name, symbolKey: `stack:${stack.id}:name`, stackId: stack.id,
    label: local ? 'StackName — current stack' : name,
    value: stack.name, expression: stack.name, kind: 'stack',
    computed: true, readOnly: true, unit: null, error: null,
  };
}

export function stackExpressionRenames(parameters, beforeStack, afterStack) {
  if (!beforeStack || !afterStack || beforeStack.name === afterStack.name) return [];
  return ['StackName', ...(parameters || [])
    .filter(parameter => parameter.kind === 'dimension' && parameter.stackId === beforeStack.id)
    .map(parameter => parameter.name)]
    .map(name => ({
      before: qualifiedDimensionName(name, beforeStack.name),
      after: qualifiedDimensionName(name, afterStack.name),
    }));
}
