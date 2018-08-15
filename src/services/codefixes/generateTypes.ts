/* @internal */
namespace ts {
    export function generateTypesForModule(packageName: string, moduleValue: unknown): ReadonlyArray<Statement> | undefined {
        const localName = codefix.moduleSpecifierToValidIdentifier(packageName, ScriptTarget.ESNext);
        const decls = getValueInfo(localName, moduleValue);
        return decls && topLevelFoo(decls);
    }

    const ignoredProperties: ReadonlySet<string> = new Set(["caller", "arguments", "constructor", "super_"]);
    const reservedFunctionProperties: ReadonlySet<string> = new Set(Object.getOwnPropertyNames(() => { }));
    function getKeysOfObject(obj: object): ReadonlyArray<string> {
        let keys: string[] = [];
        let chain = obj;
        while (chain != null && chain != Object.prototype && chain != Function.prototype) {
            keys.push(...Object.getOwnPropertyNames(chain));
            chain = Object.getPrototypeOf(chain);
        }
        return sortAndDeduplicate<string>(
            keys.filter(k => k[0] !== '_' && !ignoredProperties.has(k) && (typeof obj !== "function" || !reservedFunctionProperties.has(k))),
            ts.compareStringsCaseSensitive);
    }

    interface ObjectEntry { readonly key: string; readonly value: unknown; }
    function getEntriesOfObject(obj: object): ReadonlyArray<ObjectEntry> {
        return getKeysOfObject(obj).map(key => ({ key, value: (obj as any)[key] })); //todo: fear getters
    }

    const keyStack: string[] = []; //TODO: not global
    const walkStack = new Set<any>();//todo: not global
    function getValueInfo(name: string, obj: unknown): ValueInfo | undefined {
        if (walkStack.has(obj) || keyStack.length > 4) {
            //Circular or too-deep reference
            return { kind: ValueKind.Const, name, type: create.any(), comment: `${walkStack.has(obj) ? 'Circular reference' : 'Too-deep object hierarchy'} from ${keyStack.join('.')}` }
        }

        if (!ts.isIdentifierText(name, ts.ScriptTarget.ESNext)) return undefined;

        walkStack.add(obj);
        keyStack.push(name);
        const res: ValueInfo = typeof obj === "function" ? getFunctionInfo(obj as AnyFunction, name)
            : typeof obj === "object" ?  getObjectInfo(obj as object, name)
            : { kind: ValueKind.Const, name, type: typeFromTypeof(obj), comment: undefined };
        keyStack.pop();
        walkStack.delete(obj);
        return res;
    }

    const enum ValueKind { Const, Function, Class, Namespace }
    interface ValueInfoBase { readonly name: string; }
    type ValueInfo = ConstInfo | FunctionInfo | ClassInfo | NamespaceInfo;
    interface ConstInfo extends ValueInfoBase { readonly kind: ValueKind.Const; readonly type: TypeNode; readonly comment: string | undefined; }
    interface FunctionInfo extends ValueInfoBase {
        readonly kind: ValueKind.Function;
        readonly parameters: ReadonlyArray<ParameterDeclaration>;
        readonly returnType: TypeNode;
        readonly namespaceMembers: ReadonlyArray<Statement>;
    }
    interface ClassInfo extends ValueInfoBase {
        readonly kind: ValueKind.Class; readonly members: ReadonlyArray<ClassElementLike>; readonly namespaceMembers: ReadonlyArray<Statement> ;
    }
    interface NamespaceInfo extends ValueInfoBase {
        readonly kind: ValueKind.Namespace;
        readonly members: ReadonlyArray<ValueInfo>;
    }

    //inline
    function topLevelFoo(v: ValueInfo): ReadonlyArray<Statement> { return exportOrDeclareFoo(v, "top"); }
    //name
    function exportFoo(v: ValueInfo): ReadonlyArray<Statement> { return exportOrDeclareFoo(v, "export"); }
    //name
    function declareFoo(v: ValueInfo): ReadonlyArray<Statement> { return exportOrDeclareFoo(v, "namespace-member"); }
    //some dup of above? isEpxport could take 3 cases...
    //name
    function exportOrDeclareFoo(v: ValueInfo, kind: "top" | "export" | "namespace-member"): ReadonlyArray<Statement> {
        const mod = kind === "top" ? SyntaxKind.DeclareKeyword : kind === "export" ? SyntaxKind.ExportKeyword : undefined;
        const ex = kind === "top" ? [create.exportEquals(v.name)] : emptyArray;
        switch (v.kind) {
            case ValueKind.Const: {
                const { name, type, comment } = v;
                return [...ex, create.constVar(mod, name, type, comment)];
            }
            case ValueKind.Function: {
                const { name, parameters, returnType, namespaceMembers } = v;
                return [...ex, create.fn(mod, name, parameters, returnType), ...ns2(name, namespaceMembers, mod)];
            }
            case ValueKind.Class: {
                const { name, members, namespaceMembers } = v;
                return [...ex, create.cls(mod, name, members), ...ns2(name, namespaceMembers, mod)];
            }
            case ValueKind.Namespace: {
                const { name, members } = v;
                return kind === "top" ? flatMap(members, exportFoo) : [create.namespace(mod, name, flatMap(members, declareFoo))];
            }
            default:
                return Debug.assertNever(v);
        }
    }
    //name
    function ns2(name: string, namespaceMembers: ReadonlyArray<Statement>, mod: Modifier["kind"] | undefined): ReadonlyArray<Statement> {
        return namespaceMembers.length === 0 ? emptyArray : [create.namespace(mod, name, namespaceMembers)];
    }
    //name
    function ns2Declare(name: string, namespaceMembers: ReadonlyArray<Statement>): NamespaceDeclaration {
        return create.namespace(SyntaxKind.DeclareKeyword, name, namespaceMembers);
    }

    function getFunctionInfo(obj: AnyFunction, name: string): FunctionInfo | ClassInfo { //name
        const funcType = getParameterListAndReturnType(obj, parseFunctionBody(obj));

        const isClass = isObjectClassLike(obj);

        //Get clodule/fundule members
        const xxNamespaceMembers: Statement[] = []; //name
        const classStaticMembers: ClassElementLike[] = []; //neater?
        for (const { key, value } of getEntriesOfObject(obj)) {
            const vi = getValueInfo(key, value); //name
            if (!vi) continue;
            if (isClass) {
                switch (vi.kind) {
                    case ValueKind.Const: {
                        const { name, type, comment } = vi;
                        classStaticMembers.push(create.staticProperty(name, type, comment));
                        continue;
                    }
                    case ValueKind.Function: {
                        const { name, parameters, returnType, namespaceMembers } = vi;
                        classStaticMembers.push(create.staticMethod(name, parameters, returnType));
                        if (namespaceMembers.length) xxNamespaceMembers.push(ns2Declare(name, namespaceMembers));
                        continue;
                    }
                }
            }
            xxNamespaceMembers.push(...declareFoo(vi));
        }

        if (isClass) {
            const members = [...classStaticMembers, create.ctr(funcType[0]), ...getClassInstanceMembers(obj), ...getClassPrototypeMembers(obj)];
            return { kind: ValueKind.Class, name, members, namespaceMembers: xxNamespaceMembers }
        }
        else {
            return { kind: ValueKind.Function, name, parameters: funcType[0], returnType: funcType[1], namespaceMembers: xxNamespaceMembers }
        }
    }
    //name
    function isObjectClassLike(obj: { prototype: unknown }): boolean {
        return !!(obj.prototype && Object.getOwnPropertyNames(obj.prototype).length > 1);
    }

    function getObjectInfo(obj: object, name: string): ConstInfo | NamespaceInfo {
        const entries = getEntriesOfObject(obj);
        const hasClassOrFunction = entries.some(({ value }) => typeof value === "function");
        return hasClassOrFunction
            ? { kind: ValueKind.Namespace, name, members: flatMap(entries, ({ key, value }) => getValueInfo(key, value)) }
            : { kind: ValueKind.Const, name, type: getTypeOfValue(obj), comment: undefined }
    }

    //neater (check uses)
    const builtins: { readonly [name: string]: (new (...args: unknown[]) => unknown) | undefined } = {
        Date,
        RegExp,
        Map: (typeof Map !== 'undefined') ? Map : undefined,
        //HTMLElement: (typeof HTMLElement !== 'undefined') ? HTMLElement : undefined, //todo
    };
    function getTypeOfValue(value: unknown): TypeNode {
        //todo: do better for "function" here? this is the case if it has something that has a function. module.exports = { a: { b: function() {} } };
        if (typeof value !== "object" || value === null) return typeFromTypeof(value);

        if (Array.isArray(value)) return createArrayTypeNode(value.length ? getTypeOfValue(value[0]) : create.any());

        for (const builtinName in builtins) {
            if (builtins[builtinName] && value instanceof builtins[builtinName]!) {
                return create.typeReference(builtinName);
            }
        }

        walkStack.add(value);
        const members = getPropertyDeclarationsOfObject(value as object); //https://github.com/Microsoft/TypeScript/issues/25720#issuecomment-407237691
        walkStack.delete(value);
        return createTypeLiteralNode(members);
    }

    function typeFromTypeof(obj: unknown): TypeNode {
        const to = typeof obj;
        if (to === "function") return create.typeReference("Function");
        return createKeywordTypeNode((() => {
            switch (to) {
                case "boolean":
                    return SyntaxKind.BooleanKeyword;
                case "number":
                    return SyntaxKind.NumberKeyword;
                case "string":
                    return SyntaxKind.StringKeyword;
                case "symbol":
                    return SyntaxKind.SymbolKeyword;
                case "undefined":
                    return SyntaxKind.AnyKeyword;
                case "object":
                    return obj === null ? SyntaxKind.AnyKeyword : SyntaxKind.ObjectKeyword;
                default:
                    return Debug.assertNever(to);
            }
        })());
    }

    function getPropertyDeclarationsOfObject(obj: object): ReadonlyArray<PropertySignature> {
        walkStack.add(obj);
        const result = getEntriesOfObject(obj).map(({ key, value }) =>
            create.propertySignature(key, walkStack.has(value) ? create.any() : getTypeOfValue(value)));
        walkStack.delete(obj);
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