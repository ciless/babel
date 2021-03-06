import { template, traverse, types as t } from "@babel/core";
import { environmentVisitor } from "@babel/helper-replace-supers";
import memberExpressionToFunctions from "@babel/helper-member-expression-to-functions";
import optimiseCall from "@babel/helper-optimise-call-expression";

export function buildPrivateNamesMap(props) {
  const privateNamesMap = new Map();
  for (const prop of props) {
    if (prop.isPrivate()) {
      const { name } = prop.node.key.id;
      privateNamesMap.set(name, {
        id: prop.scope.generateUidIdentifier(name),
        static: !!prop.node.static,
      });
    }
  }
  return privateNamesMap;
}

export function buildPrivateNamesNodes(privateNamesMap, loose, state) {
  const initNodes = [];

  for (const [name, { id, static: isStatic }] of privateNamesMap) {
    // In loose mode, both static and instance fields hare transpiled using a
    // secret non-enumerable property. Hence, we also need to generate that
    // key (using the classPrivateFieldLooseKey helper) in loose mode.
    // In spec mode, only instance fields need a "private name" initializer
    // (the WeakMap), becase static fields are directly assigned to a variable
    // in the buildPrivateStaticFieldInitSpec function.

    if (loose) {
      initNodes.push(
        template.statement.ast`
          var ${id} = ${state.addHelper("classPrivateFieldLooseKey")}("${name}")
        `,
      );
    } else if (!isStatic) {
      initNodes.push(template.statement.ast`var ${id} = new WeakMap();`);
    }
  }

  return initNodes;
}

// Traverses the class scope, handling private name references.  If an inner
// class redeclares the same private name, it will hand off traversal to the
// restricted visitor (which doesn't traverse the inner class's inner scope).
const privateNameVisitor = {
  PrivateName(path) {
    const { privateNamesMap } = this;
    const { node, parentPath } = path;

    if (!parentPath.isMemberExpression({ property: node })) return;
    if (!privateNamesMap.has(node.id.name)) return;

    this.handle(parentPath);
  },

  Class(path) {
    const { privateNamesMap } = this;
    const body = path.get("body.body");

    for (const prop of body) {
      if (!prop.isClassPrivateProperty()) continue;
      if (!privateNamesMap.has(prop.node.key.id.name)) continue;

      // This class redeclares the private name.
      // So, we can only evaluate the things in the outer scope.
      path.traverse(privateNameInnerVisitor, this);
      path.skip();
      break;
    }
  },
};

// Traverses the outer portion of a class, without touching the class's inner
// scope, for private names.
const privateNameInnerVisitor = traverse.visitors.merge([
  {
    PrivateName: privateNameVisitor.PrivateName,
  },
  environmentVisitor,
]);

const privateNameHandlerSpec = {
  memoise(member, count) {
    const { scope } = member;
    const { object } = member.node;

    const memo = scope.maybeGenerateMemoised(object);
    if (!memo) {
      return;
    }

    this.memoiser.set(object, memo, count);
  },

  receiver(member) {
    const { object } = member.node;

    if (this.memoiser.has(object)) {
      return t.cloneNode(this.memoiser.get(object));
    }

    return t.cloneNode(object);
  },

  get(member) {
    const { classRef, privateNamesMap, file } = this;
    const { name } = member.node.property.id;
    const { id, static: isStatic } = privateNamesMap.get(name);

    if (isStatic) {
      return t.callExpression(
        file.addHelper("classStaticPrivateFieldSpecGet"),
        [this.receiver(member), t.cloneNode(classRef), t.cloneNode(id)],
      );
    } else {
      return t.callExpression(file.addHelper("classPrivateFieldGet"), [
        this.receiver(member),
        t.cloneNode(id),
      ]);
    }
  },

  set(member, value) {
    const { classRef, privateNamesMap, file } = this;
    const { name } = member.node.property.id;
    const { id, static: isStatic } = privateNamesMap.get(name);

    if (isStatic) {
      return t.callExpression(
        file.addHelper("classStaticPrivateFieldSpecSet"),
        [this.receiver(member), t.cloneNode(classRef), t.cloneNode(id), value],
      );
    } else {
      return t.callExpression(file.addHelper("classPrivateFieldSet"), [
        this.receiver(member),
        t.cloneNode(id),
        value,
      ]);
    }
  },

  call(member, args) {
    // The first access (the get) should do the memo assignment.
    this.memoise(member, 1);

    return optimiseCall(this.get(member), this.receiver(member), args);
  },
};

const privateNameHandlerLoose = {
  handle(member) {
    const { privateNamesMap, file } = this;
    const { object } = member.node;
    const { name } = member.node.property.id;

    member.replaceWith(
      template.expression`BASE(REF, PROP)[PROP]`({
        BASE: file.addHelper("classPrivateFieldLooseBase"),
        REF: object,
        PROP: privateNamesMap.get(name).id,
      }),
    );
  },
};

export function transformPrivateNamesUsage(
  ref,
  path,
  privateNamesMap,
  loose,
  state,
) {
  const body = path.get("body");

  if (loose) {
    body.traverse(privateNameVisitor, {
      privateNamesMap,
      file: state,
      ...privateNameHandlerLoose,
    });
  } else {
    memberExpressionToFunctions(body, privateNameVisitor, {
      privateNamesMap,
      classRef: ref,
      file: state,
      ...privateNameHandlerSpec,
    });
  }
}

function buildPrivateFieldInitLoose(ref, prop, privateNamesMap) {
  const { id } = privateNamesMap.get(prop.node.key.id.name);
  const value = prop.node.value || prop.scope.buildUndefinedNode();

  return template.statement.ast`
    Object.defineProperty(${ref}, ${id}, {
      // configurable is false by default
      // enumerable is false by default
      writable: true,
      value: ${value}
    });
  `;
}

function buildPrivateInstanceFieldInitSpec(ref, prop, privateNamesMap) {
  const { id } = privateNamesMap.get(prop.node.key.id.name);
  const value = prop.node.value || prop.scope.buildUndefinedNode();

  return template.statement.ast`${id}.set(${ref}, {
    // configurable is always false for private elements
    // enumerable is always false for private elements
    writable: true,
    value: ${value},
  })`;
}

function buildPrivateStaticFieldInitSpec(prop, privateNamesMap) {
  const { id } = privateNamesMap.get(prop.node.key.id.name);
  const value = prop.node.value || prop.scope.buildUndefinedNode();

  return template.statement.ast`
    var ${id} = {
      // configurable is false by default
      // enumerable is false by default
      writable: true,
      value: ${value}
    };
  `;
}

function buildPublicFieldInitLoose(ref, prop) {
  const { key, computed } = prop.node;
  const value = prop.node.value || prop.scope.buildUndefinedNode();

  return t.expressionStatement(
    t.assignmentExpression(
      "=",
      t.memberExpression(ref, key, computed || t.isLiteral(key)),
      value,
    ),
  );
}

function buildPublicFieldInitSpec(ref, prop, state) {
  const { key, computed } = prop.node;
  const value = prop.node.value || prop.scope.buildUndefinedNode();

  return t.expressionStatement(
    t.callExpression(state.addHelper("defineProperty"), [
      ref,
      computed || t.isLiteral(key) ? key : t.stringLiteral(key.name),
      value,
    ]),
  );
}

export function buildFieldsInitNodes(
  ref,
  props,
  privateNamesMap,
  state,
  loose,
) {
  const staticNodes = [];
  const instanceNodes = [];

  for (const prop of props) {
    const isStatic = prop.node.static;
    const isPrivate = prop.isPrivate();

    // Pattern matching please
    switch (true) {
      case isStatic && isPrivate && loose:
        staticNodes.push(
          buildPrivateFieldInitLoose(t.cloneNode(ref), prop, privateNamesMap),
        );
        break;
      case isStatic && isPrivate && !loose:
        staticNodes.push(
          buildPrivateStaticFieldInitSpec(prop, privateNamesMap),
        );
        break;
      case isStatic && !isPrivate && loose:
        staticNodes.push(buildPublicFieldInitLoose(t.cloneNode(ref), prop));
        break;
      case isStatic && !isPrivate && !loose:
        staticNodes.push(
          buildPublicFieldInitSpec(t.cloneNode(ref), prop, state),
        );
        break;
      case !isStatic && isPrivate && loose:
        instanceNodes.push(
          buildPrivateFieldInitLoose(t.thisExpression(), prop, privateNamesMap),
        );
        break;
      case !isStatic && isPrivate && !loose:
        instanceNodes.push(
          buildPrivateInstanceFieldInitSpec(
            t.thisExpression(),
            prop,
            privateNamesMap,
          ),
        );
        break;
      case !isStatic && !isPrivate && loose:
        instanceNodes.push(buildPublicFieldInitLoose(t.thisExpression(), prop));
        break;
      case !isStatic && !isPrivate && !loose:
        instanceNodes.push(
          buildPublicFieldInitSpec(t.thisExpression(), prop, state),
        );
        break;
      default:
        throw new Error("Unreachable.");
    }
  }

  return { staticNodes, instanceNodes };
}
