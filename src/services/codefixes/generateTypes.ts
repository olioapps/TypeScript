//!
namespace ts {
    export namespace create2 {
        export function constVar(name: string, type: TypeNode): VariableStatement {
            return createVariableStatement(/*modifiers*/ undefined, createVariableDeclarationList([createVariableDeclaration(name, type)], NodeFlags.Const));
        }
        export function any(): KeywordTypeNode {
            return createKeywordTypeNode(SyntaxKind.AnyKeyword)
        }
    }
}

/* @internal */
namespace ts {
    //rt type
    export function generateTypesForModule(packageName: string, moduleValue: unknown): string | undefined {
        const localName = forceAsIdentifier(packageName); //use just last part plz...
        const decls = getTopLevelDeclarations(localName, moduleValue);
        // If we get back just a namespace, we can avoid writing an export=
        if (decls.length === 1 && decls[0].kind === 'namespace') {
            // Hoist out all the declarations and export them
            const members = (decls[0] as dom.NamespaceDeclaration).members;
            for (const m of members) m.flags = m.flags! | dom.DeclarationFlags.Export;
            return members.map(m => dom.emit(m)).join('');
        } else {
            // Going to have to write an export=
            const result: string[] = decls.map(d => dom.emit(d));
            result.unshift(dom.emit(dom.create.exportEquals(localName)));
            return result.join('');
        }
    }

    import create = dom.create;
    import reservedWords = dom.reservedWords;


    const enum ValueTypes {
        None = 0,
        Class = 1 << 0,
        Function = 1 << 1,
        Object = 1 << 2,
        Primitive = 1 << 3,
        NullOrUndefined = 1 << 4,
        Unknown = 1 << 5,
    }

    const builtins: { [name: string]: (new (...args: unknown[]) => any) | undefined } = {
        Date,
        RegExp,
        Map: (typeof Map !== 'undefined') ? Map : undefined,
        //HTMLElement: (typeof HTMLElement !== 'undefined') ? HTMLElement : undefined,
    };

    function getValueTypes(value: unknown): ValueTypes {
        if (typeof value === 'object') {
            // Objects can't be callable, so no need to check for class / function
            return ValueTypes.Object;
        } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            return ValueTypes.Primitive;
        } else if (value === null || value === undefined) {
            return ValueTypes.NullOrUndefined;
        } else if (typeof value === 'function') {
            if (isClasslike(value)) {
                return ValueTypes.Class | (hasCloduleProperties(value) ? ValueTypes.Object : ValueTypes.None);
            } else {
                return ValueTypes.Function | (hasFunduleProperties(value) ? ValueTypes.Object : ValueTypes.None);
            }
        } else {
            return ValueTypes.Unknown;
        }
    }

    // A class has clodule properties if it has any classes. Anything else can be written with 'static'
    function hasCloduleProperties(c: object): boolean {
        return getKeysOfObject(c).some(k => isClasslike((c as any)[k])); //!
    }

    // A function has fundule properties if it has any own properties not belonging to Function.prototype
    function hasFunduleProperties(fn: object): boolean {
        return getKeysOfObject(fn).some(k => (<any> Function)[k] === undefined);
    }

    //name
    function forceAsIdentifier(s: string): string {
        // TODO: Make this more comprehensive
        let ret = s.replace(/-/g, '_');
        if (ret.indexOf('@') === 0 && ret.indexOf('/') !== -1) {
            // we have a scoped module, e.g. @bla/foo
            // which should be converted to   bla__foo
            ret = ret.substr(1).replace('/', '__');
        }
        return ret;
    }

    const walkStack = new Set<any>();

    const reservedFunctionProperties = Object.getOwnPropertyNames(() => {});
    function getKeysOfObject(obj: object) {
        let keys: string[] = [];
        let chain: {} = obj;
        do {
            if (chain == null) break;
            keys = keys.concat(Object.getOwnPropertyNames(chain));
            chain = Object.getPrototypeOf(chain);
        } while (chain !== Object.prototype && chain !== Function.prototype);
        keys = Array.from(new Set(keys));
        keys = keys.filter(s => isVisitableName(s));
        if (typeof obj === 'function') {
            keys = keys.filter(k => reservedFunctionProperties.indexOf(k) < 0);
        }

        keys.sort();
        return keys;
    }

    function isVisitableName(s: string) {
        return (s[0] !== '_') && (["caller", "arguments", "constructor", "super_"].indexOf(s) < 0);
    }

    function isLegalIdentifier(s: string) {
        if (s.length === 0) {
            return false;
        }
        if (!ts.isIdentifierStart(s.charCodeAt(0), ts.ScriptTarget.Latest)) {
            return false;
        }
        for (let i = 1; i < s.length; i++) {
            if (!ts.isIdentifierPart(s.charCodeAt(i), ts.ScriptTarget.Latest)) {
                return false;
            }
        }
        return reservedWords.indexOf(s) < 0;
    }

    function isClasslike(obj: { prototype: unknown }): boolean {
        return !!(obj.prototype && Object.getOwnPropertyNames(obj.prototype).length > 1);
    }

    const keyStack: string[] = [];
    function getTopLevelDeclarations(name: string, obj: unknown): ReadonlyArray<Statement> {
        if (walkStack.has(obj) || keyStack.length > 4) {
            //Circular or too-deep reference
            const result = create2.constVar(name, create2.any());
            //result.comment = (walkStack.has(obj) ? 'Circular reference' : 'Too-deep object hierarchy') +
            //    ` from ${keyStack.join('.')}`;
            return [result];
        }

        if (!isLegalIdentifier(name)) return [];

        walkStack.add(obj);
        keyStack.push(name);
        const res = getResult();
        keyStack.pop();
        walkStack.delete(obj);
        return res;

        function getResult(): ReadonlyArray<Statement> {
            if (typeof obj === 'function') {
                const funcType = getParameterListAndReturnType(obj, parseFunctionBody(obj));
                const ns = dom.create.namespace(name);
                let primaryDecl: dom.NamespaceMember;
                if (isClasslike(obj)) {
                    const cls = dom.create.class(name);
                    getClassInstanceMembers(obj).forEach(m => cls.members.push(m));
                    getClassPrototypeMembers(obj).forEach(m => cls.members.push(m));
                    cls.members.push(dom.create.constructor(funcType[0]));
                    cls.members.sort(declarationComparer);
                    primaryDecl = cls;
                } else {
                    const parsedFunction = parseFunctionBody(obj);
                    const info = getParameterListAndReturnType(obj, parsedFunction);
                    primaryDecl = dom.create.function(name, info[0], info[1]);
                }

                // Get clodule/fundule members
                const keys = getKeysOfObject(obj);
                for (const k of keys) {
                    getTopLevelDeclarations(k!, (obj as any)[k!]).forEach(p => { //! use getEntriesOfObject!
                        if (primaryDecl.kind === "class") {
                            // Transform certain declarations into static members
                            switch (p.kind) {
                                case 'const':
                                    primaryDecl.members.push(create.property(p.name, p.type, dom.DeclarationFlags.Static));
                                    break;
                                case 'function':
                                    primaryDecl.members.push(create.method(p.name, p.parameters, p.returnType, dom.DeclarationFlags.Static));
                                    break;
                                default:
                                    ns.members.push(p);
                                    break;
                            }
                        } else {
                            ns.members.push(p);
                        }
                    });
                    ns.members.sort(declarationComparer);
                }

                return ns.members.length > 0 ? [primaryDecl, ns] : [primaryDecl];
            } else if (typeof obj === 'object') {
                // If we can immediately resolve this to a simple declaration, just do so
                const simpleType = getTypeOfValue(obj);
                if (typeof simpleType === 'string' || simpleType.kind === 'name' || simpleType.kind === 'array') {
                    const result = dom.create.const(name, simpleType);
                    if (simpleType === 'string') {
                        result.comment = `Value of string: "${simpleType.substr(0, 100)}${simpleType.length > 100 ? '...' : ''}"`;
                    }
                    return [result];
                }

                // If anything in here is classlike or functionlike, write it as a namespace.
                // Otherwise, write as a 'const'
                const keys = getKeysOfObject(obj as object); // https://github.com/Microsoft/TypeScript/issues/25720#issuecomment-407237691
                let constituentTypes = ValueTypes.None;
                for (const k of keys) {
                    constituentTypes = constituentTypes | getValueTypes((<any> obj)[k!]);
                }
                if (constituentTypes & (ValueTypes.Class | ValueTypes.Function)) {
                    const ns = dom.create.namespace(name);
                    for (const k of keys) {
                        const decls = getTopLevelDeclarations(k!, (<any> obj)[k!]);
                        decls.forEach(d => ns.members.push(d));
                    }
                    ns.members.sort(declarationComparer);
                    return [ns];
                } else {
                    return [dom.create.const(name, simpleType)];
                }
            } else if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') {
                return [create.const(name, <dom.Type> (typeof obj))];
            } else {
                return [create.const(name, dom.type.any)];
            }
        }
    }

    function getTypeOfValue(value: unknown): dom.Type {
        for (const k in builtins) {
            if (builtins[k] && value instanceof builtins[k]!) {
                return create.namedTypeReference(k);
            }
        }

        if (Array.isArray(value)) {
            if (value.length > 0) {
                return create.array(getTypeOfValue(value[0]));
            } else {
                return create.array(dom.type.any);
            }
        }

        const type = typeof value;
        switch (type) {
            case 'string':
            case 'number':
            case 'boolean':
                return type;
            case 'undefined':
                return dom.type.any;
            case 'object':
                if (value === null) {
                    return dom.type.any;
                } else {
                    walkStack.add(value);
                    const members = getPropertyDeclarationsOfObject(value as object); // https://github.com/Microsoft/TypeScript/issues/25720#issuecomment-407237691
                    walkStack.delete(value);
                    members.sort(declarationComparer);
                    const objType = dom.create.objectType(members);
                    return objType;
                }
            default:
                return dom.type.any;
        }
    }

    function getPropertyDeclarationsOfObject(obj: object): dom.ObjectTypeMember[] {
        walkStack.add(obj);
        const keys = getKeysOfObject(obj);
        const result = keys.map(getProperty);
        walkStack.delete(obj);
        return result;

        function getProperty(k: string) {
            if (walkStack.has((obj as any)[k])) { //use eachentry
                return create.property(k, dom.type.any);
            }
            return create.property(k, getTypeOfValue((obj as any)[k]));
        }
    }

    function getClassPrototypeMembers(ctor: any): dom.ClassMember[] {//!
        const names = Object.getOwnPropertyNames(ctor.prototype);
        const members = <dom.ClassMember[]> names
            .filter(n => !isNameToSkip(n))
            .map(name =>
                getPrototypeMember(name, Object.getOwnPropertyDescriptor(ctor.prototype, name)!.value)) //!
            .filter(m => m !== undefined);
        members.sort();
        return members;

        function getPrototypeMember(name: string, obj: unknown): dom.ClassMember | undefined {
            // Skip non-function objects on the prototype (not sure what to do with these?)
            if (typeof obj !== 'function') {
                return undefined;
            }

            const funcType = getParameterListAndReturnType(obj, parseFunctionBody(obj));
            const result = create.method(name, funcType[0], funcType[1]);
            if (isNativeFunction(obj)) {
                result.comment = 'Native method; no parameter or return type inference available';
            }
            return result;
        }

        function isNameToSkip(s: string) {
            return (s === 'constructor') || (s[0] === '_');
        }
    }

    // Parses assignments to 'this.x' in the constructor into class property declarations
    function getClassInstanceMembers(ctor: unknown): dom.ClassMember[] {
        if (isNativeFunction(ctor as any)) { //!
            return [];
        }

        const members: dom.ClassMember[] = [];

        //todo: seems like this ought to be used
        visit;
        function visit(node: ts.Node) {
            switch (node.kind) {
                case ts.SyntaxKind.BinaryExpression:
                    if ((node as ts.BinaryExpression).operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                        const lhs = (node as ts.BinaryExpression).left;
                        if (lhs.kind === ts.SyntaxKind.PropertyAccessExpression) {
                            if ((lhs as ts.PropertyAccessExpression).expression.kind === ts.SyntaxKind.ThisKeyword) {
                                members.push(
                                    create.property(
                                        (lhs as ts.PropertyAccessExpression).name.getText(),
                                        dom.type.any,
                                        dom.DeclarationFlags.None));
                            }
                        }
                    }
                    break;
            }
            ts.forEachChild(node, visit);
        }

        return members;
    }

    function declarationComparer(left: any, right: any) { //TODO: this is just wrong. Acts on Nodes, but receives dom.ClassMembers
        if (left.kind === right.kind) {
            return left.name > right.name ? 1 : left.name < right.name ? -1 : 0;
        } else {
            return left.kind > right.kind ? 1 : left.kind < right.kind ? -1 : 0;
        }
    }

    function getParameterListAndReturnType(obj: Function, fn: ts.FunctionExpression): [dom.Parameter[], dom.Type] {
        let usedArguments = false;
        let hasReturn = false;
        const funcStack: boolean[] = [];

        if (isNativeFunction(obj)) {
            const args: dom.Parameter[] = [];
            for (let i = 0; i < obj.length; i++) {
                args.push(create.parameter(`p${i}`, dom.type.any));
            }
            return [args, dom.type.any];
        } else {
            ts.forEachChild(fn, visit);

            let params = [create.parameter('args', dom.type.array(dom.type.any), dom.ParameterFlags.Rest)];
            if (fn.parameters) {
                params = fn.parameters.map(p => create.parameter(`${p.name.getText()}`, inferParameterType(fn, p)));
                if (usedArguments) {
                    params.push(create.parameter('args', dom.type.array(dom.type.any), dom.ParameterFlags.Rest));
                }
            }
            return [params, hasReturn ? dom.type.any : dom.type.void];
        }

        function visit(node: ts.Node) {
            switch (node.kind) {
                case ts.SyntaxKind.Identifier:
                    if ((node as ts.Identifier).getText() === 'arguments') {
                        usedArguments = true;
                    }
                    break;
                case ts.SyntaxKind.ReturnStatement:
                    const ret = node as ts.ReturnStatement;
                    if (funcStack.length === 0 && ret.expression && ret.expression.kind !== ts.SyntaxKind.VoidExpression) {
                        hasReturn = true;
                    }
            }
            switch (node.kind) {
                case ts.SyntaxKind.FunctionExpression:
                case ts.SyntaxKind.FunctionDeclaration:
                    funcStack.push(true);
                    ts.forEachChild(node, visit);
                    funcStack.pop();

                default:
                    ts.forEachChild(node, visit);
                    break;
            }
        }

    }

    function inferParameterType(_fn: ts.FunctionExpression, _param: ts.ParameterDeclaration): dom.Type {
        // TODO: Inspect function body for clues
        return dom.type.any;
    }

    function parseFunctionBody(fn: Function): ts.FunctionExpression {
        const setup = `const myFn = ${fn.toString()};`;
        const srcFile = ts.createSourceFile('test.ts', setup, ts.ScriptTarget.Latest, true);
        const statement = srcFile.statements[0] as ts.VariableStatement;
        const decl = statement.declarationList.declarations[0];
        const init = decl.initializer as ts.FunctionExpression;
        return init;
    }

    function isNativeFunction(fn: Function) {
        return fn.toString().indexOf('{ [native code] }') > 0;
    }
}


//todo: this is so ugly
/* @internal */
namespace ts.dom {
    export interface DeclarationBase {
        jsDocComment?: string;
        comment?: string;
        flags?: DeclarationFlags;
    }

    export interface EnumMemberDeclaration extends DeclarationBase {
        kind: "enum-value";
        name: string;
        value?: string | number;
    }

    export interface EnumDeclaration extends DeclarationBase {
        kind: "enum";
        name: string;
        members: EnumMemberDeclaration[];
        constant: boolean;
    }

    export interface PropertyDeclaration extends DeclarationBase {
        kind: "property";
        name: string;
        type: Type;
    }

    export interface Parameter {
        kind: "parameter";
        name: string;
        type: Type;
        flags?: ParameterFlags;
    }

    export interface TypeParameter {
        kind: "type-parameter";
        name: string;
        baseType?: ObjectTypeReference|TypeParameter;
    }

    export interface IndexSignature extends DeclarationBase {
        kind: "index-signature";
        name: string;
        indexType: ("string"|"number");
        valueType: Type;
    }

    export interface CallSignature extends DeclarationBase {
        kind: "call-signature";
        parameters: Parameter[];
        returnType: Type;
        typeParameters: TypeParameter[];
    }

    export interface MethodDeclaration extends DeclarationBase {
        kind: "method";
        name: string;
        parameters: Parameter[];
        returnType: Type;
        typeParameters: TypeParameter[];
    }

    export interface FunctionDeclaration extends DeclarationBase {
        kind: "function";
        name: string;
        parameters: Parameter[];
        returnType: Type;
        typeParameters: TypeParameter[];
    }

    export interface ConstructorDeclaration extends DeclarationBase {
        kind: "constructor";
        parameters: Parameter[];
    }

    export interface ClassDeclaration extends DeclarationBase {
        kind: "class";
        name: string;
        members: ClassMember[];
        implements: InterfaceDeclaration[];
        typeParameters: TypeParameter[];
        baseType?: ObjectTypeReference;
    }

    export interface InterfaceDeclaration extends DeclarationBase {
        kind: "interface";
        name: string;
        members: ObjectTypeMember[];
        baseTypes?: ObjectTypeReference[];
    }

    export interface ImportAllDeclaration extends DeclarationBase {
        kind: "importAll";
        name: string;
        from: string;
    }

    export interface ImportNamedDeclaration extends DeclarationBase {
        kind: "importNamed";
        name: string;
        as?: string;
        from: string;
    }

    export interface ImportDefaultDeclaration extends DeclarationBase {
        kind: "importDefault";
        name: string;
        from: string;
    }

    export interface ImportEqualsDeclaration extends DeclarationBase {
        kind: "import=";
        name: string;
        from: string;
    }

    export interface ImportDeclaration extends DeclarationBase {
        kind: "import";
        from: string;
    }

    export interface NamespaceDeclaration extends DeclarationBase {
        kind: "namespace";
        name: string;
        members: NamespaceMember[];
    }

    export interface ConstDeclaration extends DeclarationBase {
        kind: "const";
        name: string;
        type: Type;
    }

    export interface VariableDeclaration extends DeclarationBase {
        kind: "var";
        name: string;
        type: Type;
    }

    export interface ExportEqualsDeclaration extends DeclarationBase {
        kind: "export=";
        target: string;
    }

    export interface ExportDefaultDeclaration extends DeclarationBase {
        kind: "exportDefault";
        name: string;
    }

    export interface ExportNameDeclaration extends DeclarationBase {
        kind: "exportName";
        name: string;
        as?: string;
    }

    export interface ModuleDeclaration extends DeclarationBase {
        kind: "module";
        name: string;
        members: ModuleMember[];
    }

    export interface ObjectType {
        kind: "object";
        members: ObjectTypeMember[];
    }

    export interface UnionType {
        kind: "union";
        members: Type[];
    }

    export interface IntersectionType {
        kind: "intersection";
        members: Type[];
    }

    export interface FunctionType {
        kind: "function-type";
        parameters: Parameter[];
        returnType: Type;
    }

    export interface TypeAliasDeclaration extends DeclarationBase {
        kind: "alias";
        name: string;
        type: Type;
        typeParameters: TypeParameter[];
    }

    export interface ArrayTypeReference {
        kind: "array";
        type: Type;
    }

    export interface NamedTypeReference {
        kind: "name";
        name: string;
    }

    export interface TypeofReference {
        kind: "typeof";
        type: NamedTypeReference;
    }

    export interface StringLiteral {
        kind: "string-literal";
        value: string;
    }

    export interface NumberLiteral {
        kind: "number-literal";
        value: number;
    }

    export interface TripleSlashReferencePathDirective {
        kind: "triple-slash-reference-path",
        path: string;
    }

    export interface TripleSlashReferenceTypesDirective {
        kind: "triple-slash-reference-types",
        types: string;
    }

    export interface TripleSlashReferenceNoDefaultLibDirective {
        kind: "triple-slash-reference-no-default-lib",
        value: boolean;
    }

    export interface TripleSlashAmdModuleDirective {
        kind: "triple-slash-amd-module",
        name?: string;
    }

    export type PrimitiveType = "string" | "number" | "boolean" | "any" | "void" | "object" | "null" | "undefined" | "true" | "false" | StringLiteral | NumberLiteral;

    export type ThisType = "this";

    export type TripleSlashDirective = TripleSlashReferencePathDirective | TripleSlashReferenceTypesDirective | TripleSlashReferenceNoDefaultLibDirective | TripleSlashAmdModuleDirective;

    export type TypeReference = TopLevelDeclaration | NamedTypeReference | ArrayTypeReference | PrimitiveType;

    export type ObjectTypeReference = ClassDeclaration | InterfaceDeclaration;
    export type ObjectTypeMember = PropertyDeclaration | MethodDeclaration | IndexSignature | CallSignature;
    export type ClassMember = PropertyDeclaration | MethodDeclaration | IndexSignature | ConstructorDeclaration;

    export type Type = TypeReference | UnionType | IntersectionType | PrimitiveType | ObjectType | TypeofReference | FunctionType | TypeParameter | ThisType;

    export type Import = ImportAllDeclaration | ImportDefaultDeclaration | ImportNamedDeclaration | ImportEqualsDeclaration | ImportDeclaration;

    export type NamespaceMember = InterfaceDeclaration | TypeAliasDeclaration | ClassDeclaration | NamespaceDeclaration | ConstDeclaration | VariableDeclaration | FunctionDeclaration;
    export type ModuleMember = InterfaceDeclaration | TypeAliasDeclaration | ClassDeclaration | NamespaceDeclaration | ConstDeclaration | VariableDeclaration | FunctionDeclaration | Import | ExportEqualsDeclaration | ExportDefaultDeclaration;
    export type TopLevelDeclaration = NamespaceMember | ExportEqualsDeclaration | ExportDefaultDeclaration | ExportNameDeclaration | ModuleDeclaration | EnumDeclaration | Import;

    export enum DeclarationFlags {
        None = 0,
        Private = 1 << 0,
        Protected = 1 << 1,
        Static = 1 << 2,
        Optional = 1 << 3,
        Export = 1 << 4,
        Abstract = 1 << 5,
        ExportDefault = 1 << 6,
        ReadOnly = 1 << 7,
    }

    export enum ParameterFlags {
        None = 0,
        Optional = 1 << 0,
        Rest = 1 << 1
    }

    export const config = {
        wrapJsDocComments: true,
        outputEol: '\r\n',
    };

    export const create = {
        interface(name: string, flags = DeclarationFlags.None): InterfaceDeclaration {
            return {
                name,
                baseTypes: [],
                kind: "interface",
                members: [],
                flags
            };
        },

        class(name: string, flags = DeclarationFlags.None): ClassDeclaration {
            return {
                kind: 'class',
                name,
                members: [],
                implements: [],
                typeParameters: [],
                flags
            };
        },

        typeParameter(name: string, baseType?: ObjectTypeReference|TypeParameter): TypeParameter {
            return {
                kind: 'type-parameter',
                name, baseType
            };
        },

        enum(name: string, constant: boolean = false, flags = DeclarationFlags.None): EnumDeclaration {
            return {
                kind: 'enum',
                name, constant,
                members: [],
                flags
            };
        },

        enumValue(name: string, value?: string | number): EnumMemberDeclaration {
            return {
                kind: 'enum-value',
                name,
                value
            };
        },

        property(name: string, type: Type, flags = DeclarationFlags.None): PropertyDeclaration {
            return {
                kind: "property",
                name, type, flags
            };
        },

        method(name: string, parameters: Parameter[], returnType: Type, flags = DeclarationFlags.None): MethodDeclaration {
            return {
                kind: "method",
                typeParameters: [],
                name, parameters, returnType, flags
            };
        },

        callSignature(parameters: Parameter[], returnType: Type): CallSignature {
            return {
                kind: "call-signature",
                typeParameters: [],
                parameters, returnType
            };
        },

        function(name: string, parameters: Parameter[], returnType: Type, flags = DeclarationFlags.None): FunctionDeclaration {
            return {
                kind: "function",
                typeParameters: [],
                name, parameters, returnType, flags
            };
        },

        functionType(parameters: Parameter[], returnType: Type): FunctionType {
            return {
                kind: "function-type",
                parameters, returnType
            };
        },

        parameter(name: string, type: Type, flags = ParameterFlags.None): Parameter {
            return {
                kind: "parameter",
                name, type, flags
            };
        },

        constructor(parameters: Parameter[], flags = DeclarationFlags.None): ConstructorDeclaration {
            return {
                kind: "constructor",
                parameters,
                flags
            };
        },

        const(name: string, type: Type, flags = DeclarationFlags.None): ConstDeclaration {
            return {
                kind: "const", name, type, flags
            };
        },

        variable(name: string, type: Type): VariableDeclaration {
            return {
                kind: "var", name, type
            };
        },

        alias(name: string, type: Type, flags = DeclarationFlags.None): TypeAliasDeclaration {
            return {
                kind: "alias", name, type,
                typeParameters: [], flags
            };
        },

        namespace(name: string): NamespaceDeclaration {
            return {
                kind: "namespace", name,
                members: []
            };
        },

        objectType(members: ObjectTypeMember[]): ObjectType {
            return {
                kind: "object",
                members
            };
        },

        indexSignature(name: string, indexType: ('string'|'number'), valueType: Type): IndexSignature {
            return {
                kind: 'index-signature',
                name, indexType, valueType
            }
        },

        array(type: Type): ArrayTypeReference {
            return {
                kind: "array",
                type
            };
        },

        namedTypeReference(name: string): NamedTypeReference {
            return {
                kind: 'name',
                name
            };
        },

        exportEquals(target: string): ExportEqualsDeclaration {
            return {
                kind: 'export=',
                target
            };
        },

        exportDefault(name: string): ExportDefaultDeclaration {
            return {
                kind: 'exportDefault',
                name
            };
        },

        exportName(name: string, as?: string): ExportNameDeclaration {
            return {
                kind: "exportName",
                name,
                as
            };
        },

        module(name: string): ModuleDeclaration {
            return {
                kind: 'module',
                name,
                members: []
            };
        },

        importAll(name: string, from: string): ImportAllDeclaration {
            return {
                kind: 'importAll',
                name,
                from
            };
        },

        importDefault(name: string, from: string): ImportDefaultDeclaration {
            return {
                kind: 'importDefault',
                name,
                from
            };
        },

        importNamed(name: string, as: string, from?: string): ImportNamedDeclaration {
            return {
                kind: 'importNamed',
                name,
                as: typeof from !== 'undefined' ? as : undefined,
                from: typeof from !== 'undefined' ? from : as
            };
        },

        importEquals(name: string, from: string): ImportEqualsDeclaration {
            return {
                kind: 'import=',
                name,
                from
            };
        },

        import(from: string): ImportDeclaration {
            return {
                kind: 'import',
                from
            };
        },

        union(members: Type[]): UnionType {
            return {
                kind: 'union',
                members
            };
        },

        intersection(members: Type[]): IntersectionType {
            return {
                kind: 'intersection',
                members
            };
        },

        typeof(type: NamedTypeReference): TypeofReference {
            return {
                kind: 'typeof',
                type
            };
        },

        tripleSlashReferencePathDirective(path: string): TripleSlashReferencePathDirective {
            return {
                kind: "triple-slash-reference-path",
                path
            };
        },

        tripleSlashReferenceTypesDirective(types: string): TripleSlashReferenceTypesDirective {
            return {
                kind: "triple-slash-reference-types",
                types
            };
        },

        tripleSlashReferenceNoDefaultLibDirective(value: boolean = true): TripleSlashReferenceNoDefaultLibDirective {
            return {
                kind: "triple-slash-reference-no-default-lib",
                value
            };
        },

        tripleSlashAmdModuleDirective(name?: string): TripleSlashAmdModuleDirective {
            return {
                kind: "triple-slash-amd-module",
                name
            };
        }
    };

    export const type = {
        array(type: Type): ArrayTypeReference {
            return {
                kind: "array",
                type
            }
        },
        stringLiteral(string: string): PrimitiveType {
            return {
                kind: "string-literal",
                value: string
            }
        },
        numberLiteral(number: number): PrimitiveType {
            return {
                kind: "number-literal",
                value: number
            }
        },
        string: <PrimitiveType>"string",
        number: <PrimitiveType>"number",
        boolean: <PrimitiveType>"boolean",
        any: <PrimitiveType>"any",
        void: <PrimitiveType>"void",
        object: <PrimitiveType>"object",
        null: <PrimitiveType>"null",
        undefined: <PrimitiveType>"undefined",
        true: <PrimitiveType>"true",
        false: <PrimitiveType>"false",
        this: <ThisType>"this"
    };

    export const reservedWords = ['abstract', 'await', 'boolean', 'break', 'byte', 'case',
        'catch', 'char', 'class', 'const', 'continue', 'debugger', 'default',
        'delete', 'do', 'double', 'else', 'enum', 'export', 'extends', 'false',
        'final', 'finally', 'float', 'for', 'function', 'goto', 'if', 'implements',
        'import', 'in', 'instanceof', 'int', 'interface', 'let', 'long', 'native',
        'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'short',
        'static', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws',
        'transient', 'true', 'try', 'typeof', 'var', 'void', 'volatile', 'while', 'with', 'yield'];

    /** IdentifierName can be written as unquoted property names, but may be reserved words. */
    export function isIdentifierName(s: string) {
        return /^[$A-Z_][0-9A-Z_$]*$/i.test(s);
    }

    /** Identifiers are e.g. legal variable names. They may not be reserved words */
    export function isIdentifier(s: string) {
        return isIdentifierName(s) && reservedWords.indexOf(s) < 0;
    }

    function quoteIfNeeded(s: string) {
        if (isIdentifierName(s)) {
            return s;
        } else {
            // JSON.stringify handles escaping quotes for us. Handy!
            return JSON.stringify(s);
        }
    }

    export enum ContextFlags {
        None = 0,
        Module = 1 << 0,
        InAmbientNamespace = 1 << 1
    }

    export function never(_: never, err: string): never { //!
        throw new Error(err);
    }

    export interface EmitOptions {
        rootFlags?: ContextFlags;
        tripleSlashDirectives?: TripleSlashDirective[];
    }

    export function emit(rootDecl: TopLevelDeclaration, { rootFlags = ContextFlags.None, tripleSlashDirectives = [] }: EmitOptions = {}): string {
        let output = "";
        let indentLevel = 0;

        const isModuleWithModuleFlag = rootDecl.kind === 'module' && rootFlags === ContextFlags.Module;
        // For a module root declaration we must omit the module flag.
        const contextStack: ContextFlags[] = isModuleWithModuleFlag ? [] : [rootFlags];

        tripleSlashDirectives.forEach(writeTripleSlashDirective);

        writeDeclaration(rootDecl);
        newline();
        return output;

        function getContextFlags() {
            return contextStack.reduce((a, b) => a | b, ContextFlags.None);
        }

        function tab() {
            for (let i = 0; i < indentLevel; i++) {
                output = output + '    ';
            }
        }

        function print(s: string) {
            output = output + s;
        }

        function start(s: string) {
            tab();
            print(s);
        }

        function classFlagsToString(flags: DeclarationFlags | undefined = DeclarationFlags.None): string {
            let out = '';

            if (flags && flags & DeclarationFlags.Abstract) {
                out += 'abstract ';
            }

            return out;
        }

        function memberFlagsToString(flags: DeclarationFlags | undefined = DeclarationFlags.None): string {
            let out = '';

            if (flags & DeclarationFlags.Private) {
                out += 'private ';
            }
            else if (flags & DeclarationFlags.Protected) {
                out += 'protected ';
            }

            if (flags & DeclarationFlags.Static) {
                out += 'static ';
            }

            if (flags & DeclarationFlags.Abstract) {
                out += 'abstract ';
            }

            if (flags & DeclarationFlags.ReadOnly) {
                out += 'readonly ';
            }

            return out;
        }

        function startWithDeclareOrExport(s: string, flags: DeclarationFlags | undefined  = DeclarationFlags.None) {
            if (getContextFlags() & ContextFlags.InAmbientNamespace) {
                // Already in an all-export context
                start(s);
            } else if (flags & DeclarationFlags.Export) {
                start(`export ${s}`);
            } else if (flags & DeclarationFlags.ExportDefault) {
                start(`export default ${s}`);
            } else if (getContextFlags() & ContextFlags.Module) {
                start(s);
            } else {
                start(`declare ${s}`);
            }
        }

        function newline() {
            output = output + config.outputEol;
        }

        function needsParens(d: Type) {
            if (typeof d === 'string') {
                return false;
            }
            switch (d.kind) {
                case "array":
                case "alias":
                case "interface":
                case "class":
                case "union":
                    return true;
                default:
                    return false;
            }
        }

        function printDeclarationComments(decl: DeclarationBase) {
            if (decl.comment) {
                start(`// ${decl.comment}`);
                newline();
            }
            if (decl.jsDocComment) {
                if (config.wrapJsDocComments) {
                    start('/**');
                    newline();
                    for(const line of decl.jsDocComment.split(/\r?\n/g)) {
                        start(` * ${line}`);
                        newline();
                    }
                    start(' */');
                }
                else {
                    start(decl.jsDocComment);
                }

                newline();
            }
        }

        function hasFlag<T extends number>(haystack: T | undefined, needle: T): boolean;
        function hasFlag(haystack: number | undefined, needle: number) {
            if (haystack === undefined) {
                return false;
            }
            return !!(needle & haystack);
        }

        function printObjectTypeMembers(members: ObjectTypeMember[]) {
            print('{');
            newline();
            indentLevel++;
            for (const member of members) {
                printMember(member);
            }
            indentLevel--;
            tab();
            print('}');

            function printMember(member: ObjectTypeMember) {
                switch (member.kind) {
                    case 'index-signature':
                        printDeclarationComments(member);
                        tab();
                        print(`[${member.name}: `);
                        writeReference(member.indexType);
                        print(']: ');
                        writeReference(member.valueType);
                        print(';');
                        newline();
                        return;
                    case "call-signature": {
                        printDeclarationComments(member);
                        tab();
                        writeTypeParameters(member.typeParameters);
                        print("(");
                        let first = true;
                        for (const param of member.parameters) {
                            if (!first) print(", ");
                            first = false;
                            print(param.name);
                            print(": ");
                            writeReference(param.type);
                        }
                        print("): ");
                        writeReference(member.returnType);
                        print(";");
                        newline();
                        return;
                    }
                    case 'method':
                        printDeclarationComments(member);
                        tab();
                        print(quoteIfNeeded(member.name));
                        if (hasFlag(member.flags, DeclarationFlags.Optional)) print('?');
                        writeTypeParameters(member.typeParameters);
                        print('(');
                        let first = true;
                        for (const param of member.parameters) {
                            if (!first) print(', ');
                            first = false;
                writeParameter(param);
                        }
                        print('): ');
                        writeReference(member.returnType);
                        print(';');
                        newline();
                        return;
                    case 'property':
                        printDeclarationComments(member);
                        tab();
                        if (hasFlag(member.flags, DeclarationFlags.ReadOnly)) print('readonly ');
                        print(quoteIfNeeded(member.name));
                        if (hasFlag(member.flags, DeclarationFlags.Optional)) print('?');
                        print(': ');
                        writeReference(member.type);
                        print(';');
                        newline();
                        return;
                }
                never(member, `Unknown member kind ${(member as ObjectTypeMember).kind}`);
            }
        }

        function writeUnionReference(d: Type) {
            if (typeof d !== "string" && d.kind === "function-type") {
                print('(')
                writeReference(d)
                print(')')
            } else {
                writeReference(d)
            }
        }

        function writeReference(d: Type) {
            if (typeof d === 'string') {
                print(d);
            } else {
                const e = d;
                switch (e.kind) {
                    case "type-parameter":
                    case "class":
                    case "interface":
                    case "name":
                    case "alias":
                        print(e.name);
                        break;

                    case "array":
                        if (needsParens(e.type)) print('(');
                        writeReference(e.type);
                        if (needsParens(e.type)) print(')');
                        print('[]');
                        break;

                    case "object":
                        printObjectTypeMembers(e.members);
                        break;

                    case "string-literal":
                        print(JSON.stringify(e.value));
                        break;

                    case "number-literal":
                        if (isNaN(e.value)) print("typeof NaN");
                        else if (!isFinite(e.value)) print("typeof Infinity");
                        else print(e.value.toString());
                        break;

                    case "function-type":
                        writeFunctionType(e);
                        break;

                    case "union":
                        writeDelimited(e.members, ' | ', writeUnionReference);
                        break;

                    case "intersection":
                        writeDelimited(e.members, ' & ', writeUnionReference)
                        break;

                    case "typeof":
                        print("typeof ");
                        writeReference(e.type);
                        break;

                    default:
                        throw new Error(`Unknown kind ${d.kind}`);
                }

            }
        }

        function writeTypeParameters(params: TypeParameter[]) {
            if (params.length === 0) return;

            print('<');

            let first = true;

            for (const p of params) {
                if (!first) print(', ');

                print(p.name);

                if (p.baseType) {
                    print(' extends ');

                    if (p.baseType.kind === 'type-parameter')
                        print(p.baseType.name);
                    else
                        writeReference(p.baseType);
                }

                first = false;
            }

            print('>');
        }

        function writeInterface(d: InterfaceDeclaration) {
            printDeclarationComments(d);
            startWithDeclareOrExport(`interface ${d.name} `, d.flags);
            if (d.baseTypes && d.baseTypes.length) {
                print(`extends `);
                let first = true;
                for (const baseType of d.baseTypes) {
                    if (!first) print(', ');
                    writeReference(baseType);
                    first = false;
                }
            }
            printObjectTypeMembers(d.members);
            newline();
        }

        function writeFunctionType(f: FunctionType) {
            print('(');
            writeDelimited(f.parameters, ', ', writeParameter);
            print(')');
            print('=>');
            writeReference(f.returnType);
        }

        function writeFunction(f: FunctionDeclaration) {
            printDeclarationComments(f);
            if (!isIdentifier(f.name)) {
                start(`/* Illegal function name '${f.name}' can't be used here`);
                newline();
            }

            startWithDeclareOrExport(`function ${f.name}`, f.flags);
            writeTypeParameters(f.typeParameters);
            print('(')
            writeDelimited(f.parameters, ', ', writeParameter);
            print('): ');
            writeReference(f.returnType);
            print(';');
            newline();

            if (!isIdentifier(f.name)) {
                start(`*/`);
                newline();
            }
        }

        function writeParameter(p: Parameter) {
            const flags = p.flags || DeclarationFlags.None;
            print(`${flags & ParameterFlags.Rest ? '...' : ''}${p.name}${flags & ParameterFlags.Optional ? '?' : ''}: `);
            writeReference(p.type);
        }

        function writeDelimited<T>(arr: T[], sep: string, printer: (x: T) => void) {
            let first = true;
            for (const el of arr) {
                if (!first) {
                    print(sep);
                }
                printer(el);
                first = false;
            }
        }

        function writeClass(c: ClassDeclaration) {
            printDeclarationComments(c);
            startWithDeclareOrExport(`${classFlagsToString(c.flags)}class ${c.name}`, c.flags);
            writeTypeParameters(c.typeParameters);
            if (c.baseType) {
                print(' extends ');
                writeReference(c.baseType);
            }
            if (c.implements && c.implements.length) {
                print(' implements ');
                let first = true;
                for (const impl of c.implements) {
                    if (!first) print(', ');
                    writeReference(impl);
                    first = false;
                }
            }
            print(' {');
            newline();
            indentLevel++;
            for (const m of c.members) {
                writeClassMember(m);
                newline();
            }
            indentLevel--;
            start('}');
            newline();
        }

        function writeClassMember(c: ClassMember) {
            switch (c.kind) {
                case "property":
                    return writePropertyDeclaration(c);
                case "method":
                    return writeMethodDeclaration(c);
                case "constructor":
                    return writeConstructorDeclaration(c);
            }
        }

        function writeConstructorDeclaration(ctor: ConstructorDeclaration) {
            printDeclarationComments(ctor);
            start('constructor(');
            writeDelimited(ctor.parameters, ', ', writeParameter);
            print(');')
            newline();
        }

        function writePropertyDeclaration(p: PropertyDeclaration) {
            printDeclarationComments(p);
            start(`${memberFlagsToString(p.flags)}${quoteIfNeeded(p.name)}: `);
            writeReference(p.type);
            print(';');
            newline();
        }

        function writeMethodDeclaration(m: MethodDeclaration) {
            printDeclarationComments(m);
            start(`${memberFlagsToString(m.flags)}${quoteIfNeeded(m.name)}`);
            writeTypeParameters(m.typeParameters);
            print('(');
            writeDelimited(m.parameters, ', ', writeParameter);
            print('): ');
            writeReference(m.returnType);
            print(';');
            newline();
        }

        function writeNamespace(ns: NamespaceDeclaration) {
            printDeclarationComments(ns);
            startWithDeclareOrExport(`namespace ${ns.name} {`, ns.flags);
            contextStack.push(ContextFlags.InAmbientNamespace);
            newline();
            indentLevel++;
            for (const member of ns.members) {
                writeDeclaration(member);
                newline();
            }
            indentLevel--;
            start(`}`);
            contextStack.pop();
            newline();
        }

        function writeConst(c: ConstDeclaration) {
            printDeclarationComments(c);
            startWithDeclareOrExport(`const ${c.name}: `, c.flags);
            writeReference(c.type);
            print(';');
            newline();
        }

        function writeVar(c: VariableDeclaration) {
            printDeclarationComments(c);
            startWithDeclareOrExport(`var ${c.name}: `, c.flags);
            writeReference(c.type);
            print(';');
            newline();
        }

        function writeAlias(a: TypeAliasDeclaration) {
            printDeclarationComments(a);
            startWithDeclareOrExport(`type ${a.name}`, a.flags);
            writeTypeParameters(a.typeParameters);
            print(' = ');
            writeReference(a.type);
            print(';');
            newline();
        }

        function writeExportEquals(e: ExportEqualsDeclaration) {
            start(`export = ${e.target};`);
            newline();
        }

        function writeExportDefault(e: ExportDefaultDeclaration) {
            start(`export default ${e.name};`);
            newline();
        }

        function writeExportName(e: ExportNameDeclaration) {
            start(`export { ${e.name}`);
            if (e.as) {
                print(` as ${e.as}`);
            }
            print(' };');
            newline();
        }

        function writeModule(m: ModuleDeclaration) {
            printDeclarationComments(m);
            startWithDeclareOrExport(`module '${m.name}' {`, m.flags);
            contextStack.push(ContextFlags.Module);
            newline();
            indentLevel++;
            for (const member of m.members) {
                writeDeclaration(member);
                newline();
            }
            indentLevel--;
            start(`}`);
            contextStack.pop();
            newline();
        }

        function writeImportAll(i: ImportAllDeclaration) {
            start(`import * as ${i.name} from '${i.from}';`);
            newline();
        }

        function writeImportDefault(i: ImportDefaultDeclaration) {
            start(`import ${i.name} from '${i.from}';`);
            newline();
        }

        function writeImportNamed(i: ImportNamedDeclaration) {
            start(`import {${i.name}`);
            if (i.as) {
                print(` as ${i.as}`);
            }
            print(`} from '${i.from}';`);
            newline();
        }

        function writeImportEquals(i: ImportEqualsDeclaration) {
            start(`import ${i.name} = require('${i.from}');`);
            newline();
        }

        function writeImport(i: ImportDeclaration) {
            start(`import '${i.from}';`);
            newline();
        }

        function writeEnum(e: EnumDeclaration) {
            printDeclarationComments(e);
            startWithDeclareOrExport(`${e.constant ? 'const ' : ''}enum ${e.name} {`, e.flags);
            newline();
            indentLevel++;
            for (const member of e.members) {
                writeEnumValue(member);
            }
            indentLevel--;
            start(`}`);
            newline();
        }

        function writeEnumValue(e: EnumMemberDeclaration) {
            printDeclarationComments(e);
            start(e.name);

            if (e.value) {
                if (typeof e.value === 'string') {
                    print(` = "${e.value}"`);
                } else {
                    print(` = ${e.value}`);
                }
            }

            print(',');
            newline();
        }

        function writeTripleSlashDirective(t: TripleSlashDirective) {
            const type = t.kind === "triple-slash-amd-module" ? "amd-module" : "reference";
            start(`/// <${type}`);

            switch (t.kind) {
                case "triple-slash-reference-path":
                    print(` path="${t.path}"`);
                    break;
                case "triple-slash-reference-types":
                    print(` types="${t.types}"`);
                    break;
                case "triple-slash-reference-no-default-lib":
                    print(` no-default-lib="${t.value}"`);
                    break;
                case "triple-slash-amd-module":
                    if (t.name) {
                        print(` name="${t.name}"`);
                    }
                    break;
                default:
                    never(t, `Unknown triple slash directive kind ${(t as TripleSlashDirective).kind}`);
            }

            print(" />");
            newline();
        }

        function writeDeclaration(d: TopLevelDeclaration) {
            if (typeof d === 'string') {
                return print(d);
            } else {
                switch (d.kind) {
                    case "interface":
                        return writeInterface(d);
                    case "function":
                        return writeFunction(d);
                    case "class":
                        return writeClass(d);
                    case "namespace":
                        return writeNamespace(d);
                    case "const":
                        return writeConst(d);
                    case "var":
                        return writeVar(d);
                    case "alias":
                        return writeAlias(d);
                    case "export=":
                        return writeExportEquals(d);
                    case "exportDefault":
                        return writeExportDefault(d);
                    case "exportName":
                        return writeExportName(d);
                    case "module":
                        return writeModule(d);
                    case "importAll":
                        return writeImportAll(d);
                    case "importDefault":
                        return writeImportDefault(d);
                    case "importNamed":
                        return writeImportNamed(d);
                    case "import=":
                        return writeImportEquals(d);
                    case "import":
                        return writeImport(d);
                    case "enum":
                        return writeEnum(d);

                    default:
                        return never(d, `Unknown declaration kind ${(d as TopLevelDeclaration).kind}`);
                }
            }
        }
    }
}
