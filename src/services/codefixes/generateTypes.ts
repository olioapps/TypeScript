/* @internal */
namespace ts {
    //rt type
    export function generateTypesForModule(packageName: string, moduleValue: unknown): ReadonlyArray<Statement> | undefined {
        const localName = codefix.moduleSpecifierToValidIdentifier(packageName, ScriptTarget.ESNext);
        const decls = getDeclarationsFromValue(localName, moduleValue);
        return decls && topLevelFoo(decls);
    }

    const walkStack = new Set<any>();

    const reservedFunctionProperties = Object.getOwnPropertyNames(() => { });
    //getentries instead
    function getKeysOfObject(obj: object) {
        let keys: string[] = [];
        let chain: {} = obj;
        do {
            if (chain == null) break;
            keys = keys.concat(Object.getOwnPropertyNames(chain));
            chain = Object.getPrototypeOf(chain);
        } while (chain !== Object.prototype && chain !== Function.prototype);
        keys = Array.from(new Set(keys));
        keys = keys.filter(s => (s[0] !== '_') && (["caller", "arguments", "constructor", "super_"].indexOf(s) < 0));
        if (typeof obj === 'function') {
            keys = keys.filter(k => reservedFunctionProperties.indexOf(k) < 0);
        }

        keys.sort();
        return keys;
    }

    //name
    function isObjectClassLike(obj: { prototype: unknown }): boolean {
        return !!(obj.prototype && Object.getOwnPropertyNames(obj.prototype).length > 1);
    }

    //!
    type TopLevelDeclaration = ClassDeclaration | FunctionDeclaration | VariableStatement | NamespaceDeclaration;

    const keyStack: string[] = []; //TODO: not global

    /*
    A value must be one of:
    - plain function/class/primitive (export =)
    - function/class and namespace (function merged with namespace -- give up for static?)
    - just an object (pure namespace)
    */
    //NOTE: if sending to a class, use static method instead of namespace if possible (TEST)
    //RETURN: optional export=, optional namespace
    //PARAM: need to know whether to add `export` directly (for object), or `static` property/method
    function getDeclarationsFromValue(name: string, obj: unknown): ValueInfo | undefined {
        if (walkStack.has(obj) || keyStack.length > 4) {
            //Circular or too-deep reference
            return { kind: "const", name, type: create.any(), comment: `${walkStack.has(obj) ? 'Circular reference' : 'Too-deep object hierarchy'} from ${keyStack.join('.')}` }
        }

        if (!ts.isIdentifierText(name, ts.ScriptTarget.ESNext)) return undefined;

        walkStack.add(obj);
        keyStack.push(name);
        const res = ((): ValueInfo => {
            const typeofObj = typeof obj;
            switch (typeofObj) {
                case "function":
                    return fooFn(obj as AnyFunction, name);
                case "object":
                    return fooObj(obj as object, name); // TODO: GH#26327
                case "boolean":
                case "number":
                case "string":
                case "symbol":
                case "undefined":
                    return { kind: "const", name, type: typeFromTypeof(obj), comment: undefined };
                default:
                    return Debug.assertNever(typeofObj);
            }
        })();
        keyStack.pop();
        walkStack.delete(obj);
        return res;
    }

    //name
    type ValueInfo =
        | { kind: "const", name: string, type: TypeNode, comment: string | undefined }
        | { kind: "function", name: string, parameters: ReadonlyArray<ParameterDeclaration>, returnType: TypeNode, ns: NS2 | undefined }
        | { kind: "class", name: string, members: ReadonlyArray<ClassElementLike>, ns: NS2 | undefined }
        | { kind: "namespace", ns: NS };
    //name
    type NS = { name: string, members: ReadonlyArray<ValueInfo> };
    //name2
    type NS2 = { name: string, members: ReadonlyArray<TopLevelDeclaration> }; //name is redundant, stored in parent

    function topLevelFoo(v: ValueInfo): ReadonlyArray<Statement> {
        switch (v.kind) {
            case "const": {
                const { name, type, comment } = v;
                return [create.exportEquals(name), create.constVar(SyntaxKind.DeclareKeyword, name, type, comment)];
            }
            case "function": {
                const { name, parameters, returnType, ns } = v;
                return [create.exportEquals(name), create.fn(SyntaxKind.DeclareKeyword, name, parameters, returnType), ...ns2(ns, SyntaxKind.DeclareKeyword)];
            }
            case "class": {
                const { name, members, ns } = v;
                return [create.exportEquals(name), create.cls(SyntaxKind.DeclareKeyword, name, members), ...ns2(ns, SyntaxKind.DeclareKeyword)];
            }
            case "namespace": {
                const { ns } = v;
                return flatMap(ns.members, exportFoo);
            }
            default:
                return Debug.assertNever(v);
        }
    }
    function exportFoo(v: ValueInfo): ReadonlyArray<TopLevelDeclaration> { return exportOrDeclareFoo(v, true); }
    function declareFoo(v: ValueInfo): ReadonlyArray<TopLevelDeclaration> { return exportOrDeclareFoo(v, false); }
    //some dup of above? isEpxport could take 3 cases...
    function exportOrDeclareFoo(v: ValueInfo, isExport: boolean): ReadonlyArray<TopLevelDeclaration> {
        const mod = isExport ? SyntaxKind.ExportKeyword : undefined;
        switch (v.kind) {
            case "const": {
                const { name, type, comment } = v;
                return [create.constVar(mod, name, type, comment)];
            }
            case "function": {
                const { name, parameters, returnType, ns } = v;
                return [create.fn(mod, name, parameters, returnType), ...ns2(ns, mod)];
            }
            case "class": {
                const { name, members, ns } = v;
                return [create.cls(mod, name, members), ...ns2(ns, mod)];
            }
            case "namespace": {
                const { ns } = v;
                return [create.namespace(mod, ns.name, flatMap(ns.members, declareFoo))];
            }
            default:
                return Debug.assertNever(v);
        }
    }
    function ns2(ns2: NS2 | undefined, mod: Modifier["kind"] | undefined): ReadonlyArray<TopLevelDeclaration> {
        return ns2 === undefined ? emptyArray : [create.namespace(mod, ns2.name, ns2.members)];
    }
    function ns2Declare(ns2: NS2) {
        return create.namespace(SyntaxKind.DeclareKeyword, ns2.name, ns2.members);
    }

    function fooFn(obj: AnyFunction, name: string): ValueInfo { //name
        const funcType = getParameterListAndReturnType(obj, parseFunctionBody(obj));

        const isClass = isObjectClassLike(obj);
        const classMembers: ClassElementLike[] = []; //neater?

        //Get clodule/fundule members
        const namespaceMembers: TopLevelDeclaration[] = [];
        for (const k of getKeysOfObject(obj)) {
            const vi = getDeclarationsFromValue(k, (obj as any)[k]); //name
            if (!vi) continue;
            if (isClass) {
                switch (vi.kind) {
                    case "const": {
                        //instead, static property
                        const { name, type, comment } = vi;
                        classMembers.push(create.staticProperty(name, type, comment));
                        continue;
                    }
                    case "function": {
                        //instead, static method
                        const { name, parameters, returnType, ns } = vi;
                        classMembers.push(create.staticMethod(name, parameters, returnType));
                        if (ns) namespaceMembers.push(ns2Declare(ns));
                        continue;
                    }
                }
            }
            namespaceMembers.push(...declareFoo(vi));
        }
        namespaceMembers.sort(declarationComparer);

        const ns: NS2 | undefined = namespaceMembers.length !== 0 ? { name, members: namespaceMembers } : undefined;
        if (isClass) {
            const members = [
                ...getClassInstanceMembers(obj),
                ...getClassPrototypeMembers(obj),
                create.ctr(funcType[0]),
                ...classMembers,
            ].sort(declarationComparer);
            return { kind: "class", name, members, ns }
        }
        else {
            return { kind: "function", name, parameters: funcType[0], returnType: funcType[1], ns }
        }
    }

    function fooObj(obj: object, name: string): ValueInfo { //name
        // If we can immediately resolve this to a simple declaration, just do so
        const simpleType = getTypeOfValue(obj);
        //pretty sure below would never happen.
        //if (typeof simpleType === 'string' || simpleType.kind === 'name' || simpleType.kind === 'array') {
        //    const result = create2.constVar(name, simpleType);
        //    if (simpleType === 'string') {
        //        result.comment = `Value of string: "${simpleType.substr(0, 100)}${simpleType.length > 100 ? '...' : ''}"`;
        //    }
        //    return [result];
        //}

        //If anything in here is classlike or functionlike, write it as a namespace.
        //Otherwise, write as a 'const'
        const keys = getKeysOfObject(obj);
        const hasClassOrFunction = keys.some(k => typeof (<any>obj)[k] === "function"); //entries
        return hasClassOrFunction
            ? { kind: "namespace", ns: { name, members: flatMap(keys, k => getDeclarationsFromValue(k, (<any>obj)[k])) }}
            : { kind: "const", name, type: simpleType, comment: undefined }
    }


    //neater (check uses)
    const builtins: { [name: string]: (new (...args: unknown[]) => any) | undefined } = {
        Date,
        RegExp,
        Map: (typeof Map !== 'undefined') ? Map : undefined,
        //HTMLElement: (typeof HTMLElement !== 'undefined') ? HTMLElement : undefined,
    };
    function getTypeOfValue(value: unknown): TypeNode {
        for (const k in builtins) {
            if (builtins[k] && value instanceof builtins[k]!) {
                return create.typeReference(k);
            }
        }

        if (Array.isArray(value)) {
            if (value.length > 0) {
                return createArrayTypeNode(getTypeOfValue(value[0]));
            } else {
                return createArrayTypeNode(create.any());
            }
        }

        const type = typeof value;
        switch (type) {
            case "string":
            case "number":
            case "boolean":
            case "symbol":
            case "function":
                return typeFromTypeof(value);
            case 'undefined':
                return create.any();
            case 'object':
                if (value === null) {
                    return create.any();
                } else {
                    walkStack.add(value);
                    const members = getPropertyDeclarationsOfObject(value as object); // https://github.com/Microsoft/TypeScript/issues/25720#issuecomment-407237691
                    walkStack.delete(value);
                    return createTypeLiteralNode(members);
                }
            default:
                return Debug.assertNever(type);
        }
    }

    function typeFromTypeof(obj: unknown): TypeNode {
        const to = typeof obj;
        if (to === "function") return create.typeReference("Function");
        return createKeywordTypeNode((() => {
            switch (to) {
                case "object":
                    return obj === null ? SyntaxKind.NullKeyword : SyntaxKind.ObjectKeyword;
                case "boolean":
                    return SyntaxKind.BooleanKeyword;
                case "number":
                    return SyntaxKind.NumberKeyword;
                case "string":
                    return SyntaxKind.StringKeyword;
                case "symbol":
                    return SyntaxKind.SymbolKeyword;
                case "undefined":
                    return SyntaxKind.UndefinedKeyword;
                default:
                    return Debug.assertNever(to);
            }
        })());
    }

    function getPropertyDeclarationsOfObject(obj: object): ReadonlyArray<PropertySignature> {
        walkStack.add(obj);
        //use eachentry
        const result = getKeysOfObject(obj).map(k => create.propertySignature(k, walkStack.has((obj as any)[k]) ? create.any() : getTypeOfValue((obj as any)[k])));
        walkStack.delete(obj);
        result.sort(declarationComparer);
        return result;
    }

    function getClassPrototypeMembers(ctor: any): ReadonlyArray<MethodDeclaration> {//! remove 'any'
        return mapDefined(Object.getOwnPropertyNames(ctor.prototype), name =>
            isNameToSkip(name) ? undefined : getPrototypeMember(name, Object.getOwnPropertyDescriptor(ctor.prototype, name)!.value)).sort();

    }
    function getPrototypeMember(name: string, obj: unknown): MethodDeclaration | undefined {
        // Skip non-function objects on the prototype (not sure what to do with these?)
        if (typeof obj !== 'function') return undefined;

        const funcType = getParameterListAndReturnType(obj as AnyFunction, parseFunctionBody(obj as AnyFunction));
        return create.method(name, funcType[0], funcType[1]);
        //todo
        //if (isNativeFunction(obj)) {
        //    result.comment = 'Native method; no parameter or return type inference available';
        //}
    }
    function isNameToSkip(s: string): boolean {
        return (s === 'constructor') || (s[0] === '_');
    }

    // Parses assignments to 'this.x' in the constructor into class property declarations
    function getClassInstanceMembers(ctor: unknown): ReadonlyArray<PropertyDeclaration> {
        if (isNativeFunction(ctor as any)) { //!
            return emptyArray;
        }

        const members: PropertyDeclaration[] = [];

        visit; //todo: seems like this ought to be used
        function visit(node: ts.Node) {
            if (isBinaryExpression(node)) {
                const { left, operatorToken } = node;
                if (operatorToken.kind === ts.SyntaxKind.EqualsToken && isPropertyAccessExpression(left) && left.expression.kind === ts.SyntaxKind.ThisKeyword) {
                    members.push(create.property(left.name.text, create.any()));
                }
            }
            node.forEachChild(visit);
        }

        return members;
    }

    type Ttt = ClassElementLike | TopLevelDeclaration | PropertySignature; //name
    //todo: sort *before* convert to nodes?
    function declarationComparer(left: Ttt, right: Ttt): number {
        return left.kind === right.kind
            ? compareStringsCaseSensitive(getName(left), getName(right))
            : compareValues(left.kind, right.kind);
    }
    function getName(node: Ttt): string { //neater
        return node.kind === SyntaxKind.VariableStatement
            ? onlyVar(node).name
            : cast(node.name, isIdentifier).text; //watch out for stringliterals tho
    }
    //!
    function onlyVar(node: VariableStatement) {//rt type
        const decl = first(node.declarationList.declarations);
        return { name: cast(decl.name, isIdentifier).text, type: Debug.assertDefined(decl.type) };
    }

    //mv
    function fill<T>(length: number, cb: (index: number) => T): T[] {
        return new Array(length).map((_, i) => cb(i));
    }

    //tuples are evil
    function getParameterListAndReturnType(obj: AnyFunction, fn: ts.FunctionExpression): [ParameterDeclaration[], TypeNode] {
        if (isNativeFunction(obj)) {
            return [fill(obj.length, i => create.parameter(`p${i}`, create.any())), create.any()];
        }

        let usedArguments = false;
        let hasReturn = false;
        const funcStack: boolean[] = [];
        fn.forEachChild(visit);
        const params = fn.parameters
            ? [
                ...fn.parameters.map(p => create.parameter(`${p.name.getText()}`, inferParameterType(fn, p))),
                ...(usedArguments ? [create.restParameter('args', createArrayTypeNode(create.any()))] : emptyArray),
            ]
            : [create.restParameter('args', createArrayTypeNode(create.any()))];
        return [params, hasReturn ? create.any() : create.voidType()];

        function visit(node: ts.Node) { //neater
            switch (node.kind) {
                case ts.SyntaxKind.Identifier:
                    if ((node as ts.Identifier).getText() === 'arguments') {
                        usedArguments = true;
                    }
                    break;
                case ts.SyntaxKind.ReturnStatement:
                    const { expression } = node as ts.ReturnStatement;
                    if (funcStack.length === 0 && expression && expression.kind !== ts.SyntaxKind.VoidExpression) {
                        hasReturn = true;
                    }
            }
            switch (node.kind) {
                case ts.SyntaxKind.FunctionExpression:
                case ts.SyntaxKind.FunctionDeclaration:
                    funcStack.push(true);
                    node.forEachChild(visit);
                    funcStack.pop();

                default:
                    node.forEachChild(visit);
                    break;
            }
        }
    }

    function inferParameterType(_fn: ts.FunctionExpression, _param: ts.ParameterDeclaration): TypeNode {
        // TODO: Inspect function body for clues
        return create.any();
    }

    function parseFunctionBody(fn: AnyFunction): ts.FunctionExpression {
        const setup = `const myFn = ${fn.toString()};`;
        const srcFile = createSourceFile('test.ts', setup, ts.ScriptTarget.Latest, true);
        const statement = srcFile.statements[0] as ts.VariableStatement;
        const decl = statement.declarationList.declarations[0];
        return decl.initializer as ts.FunctionExpression;
    }

    function isNativeFunction(fn: AnyFunction): boolean {
        return stringContains(fn.toString(), '{ [native code] }');
    }

    export namespace create {
        //!
        function modfoo(modifier: Modifier["kind"] | undefined) {
            return modifier === undefined ? undefined : [createModifier(modifier) as Modifier]
        }

        export function constVar(modifier: Modifier["kind"] | undefined, name: string, type: TypeNode, comment: string | undefined): VariableStatement {
            comment;//TODO
            return createVariableStatement(
                modfoo(modifier),
                createVariableDeclarationList([createVariableDeclaration(name, type)], NodeFlags.Const));
        }
        export function any(): KeywordTypeNode {
            return createKeywordTypeNode(SyntaxKind.AnyKeyword)
        }
        export function voidType(): KeywordTypeNode {
            return createKeywordTypeNode(SyntaxKind.VoidKeyword);
        }
        export function typeReference(name: string): TypeReferenceNode {
            return createTypeReferenceNode(name, /*typeArguments*/ undefined);
        }
        export function fn(modifier: Modifier["kind"] | undefined, name: string, parameters: ReadonlyArray<ParameterDeclaration>, returnType: TypeNode): FunctionDeclaration {
            return createFunctionDeclaration(/*decorators*/ undefined, modfoo(modifier), /*asteriskToken*/ undefined, name, /*typeParameters*/ undefined, parameters, returnType, /*body*/ undefined);
        }
        export function cls(modifier: Modifier["kind"] | undefined, name: string, elements: ReadonlyArray<ClassElement>): ClassDeclaration {
            return createClassDeclaration(/*decorators*/ undefined, modfoo(modifier), name, /*typeParameters*/ undefined, /*heritageClauses*/ undefined, elements);
        }
        export function ctr(parameters: ReadonlyArray<ParameterDeclaration>): ConstructorDeclaration {
            return createConstructor(/*decorators*/ undefined, /*modifiers*/ undefined, parameters, /*body*/ undefined);
        }
        export function parameter(name: string, type: TypeNode): ParameterDeclaration {
            return createParameter(/*decorators*/ undefined, /*modifiers*/ undefined, /*dotDotDotToken*/ undefined, name, /*questionToken*/ undefined, type, /*initializer*/ undefined);
        }
        export function restParameter(name: string, type: TypeNode): ParameterDeclaration {
            return createParameter(/*decorators*/ undefined, /*modifiers*/ undefined, /*dotDotDotToken*/ createToken(SyntaxKind.DotDotDotToken), name, /*questionToken*/ undefined, type, /*initializer*/ undefined);
        }
        export function method(name: string, parameters: ReadonlyArray<ParameterDeclaration>, returnType: TypeNode): MethodDeclaration {
            return createMethod(
                /*decorators*/ undefined,
                /*modifiers*/ undefined,
                /*asteriskToken*/ undefined,
                name,
                /*questionToken*/ undefined,
                /*typeParameters*/ undefined,
                parameters,
                returnType,
                /*body*/ undefined);
        }
        export function staticMethod(name: string, parameters: ReadonlyArray<ParameterDeclaration>, returnType: TypeNode): MethodDeclaration {
            return createMethod(
                /*decorators*/ undefined,
                /*modifiers*/[createModifier(SyntaxKind.StaticKeyword)],
                /*asteriskToken*/ undefined,
                name,
                /*questionToken*/ undefined,
                /*typeParameters*/ undefined,
                parameters,
                returnType,
                /*body*/ undefined);
        }

        export function property(name: string, type: TypeNode): PropertyDeclaration {
            return createProperty(/*decorators*/ undefined, /*modifiers*/ undefined, name, /*questionOrExclamationToken*/ undefined, type, /*initializer*/ undefined);
        }
        export function propertySignature(name: string, type: TypeNode): PropertySignature {
            return createPropertySignature(/*modifiers*/ undefined, name, /*questionToken*/ undefined, type, /*initializer*/ undefined);
        }
        export function staticProperty(name: string, type: TypeNode, comment: string | undefined): PropertyDeclaration {
            comment; //todo
            return createProperty(
                /*decorators*/ undefined,
                /*modifiers*/[createModifier(SyntaxKind.StaticKeyword)],
                name,
                /*questionOrExclamationToken*/ undefined,
                type,
                /*initializer*/ undefined);
        }

        export function namespace(modifier: Modifier["kind"] | undefined, name: string, statements: ReadonlyArray<Statement>): NamespaceDeclaration {
            return createModuleDeclaration(/*decorators*/ undefined, modfoo(modifier), createIdentifier(name), createModuleBlock(statements)) as NamespaceDeclaration;
        }

        export function exportEquals(name: string): ExportAssignment {
            return createExportAssignment(/*decorators*/ undefined, /*modifiers*/ undefined, /*isExportEquals*/ true, createIdentifier(name));
        }
    }
}