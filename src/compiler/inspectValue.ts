namespace ts {
    export interface InspectValueOptions {
        fileNameToRequire: string;
    }

    //used?
    export function getRequirePathForInspectValue(fromFile: string, packageName: string, host: ModuleResolutionHost): string {
        return resolveJavaScriptModule(packageName, getDirectoryPath(fromFile), host);
    }

    function tryRequire(fileNameToRequire: string): unknown {
        //const requireFromPath = resolveJavaScriptModule(packageName, getDirectoryPath(fromFile), host);
        try {
            return require(fileNameToRequire);
        }
        catch {
            return undefined;
        }
    }

    export const enum ValueKind { Const, Array, FunctionOrClass, Object }
    export interface ValueInfoBase {
        readonly name: string;
    }
    //replace with one from inspectValue
    //string is for basic types
    export type ValueInfo = OtherInfo | ArrayInfo | FunctionOrClassInfo | ObjectInfo;
    //interface ConstInfo extends ValueInfoBase { //name: othertypeinfo
    //    readonly kind: ValueKind.Const;
    //    readonly type: TypeInfo;
    //    readonly comment: string | undefined;
    //}
    //name
    export interface OtherInfo extends ValueInfoBase {
        readonly kind: ValueKind.Const;
        readonly typeName: string;
        readonly comment?: string | undefined;
    }
    export interface FunctionOrClassInfo extends ValueInfoBase {
        readonly kind: ValueKind.FunctionOrClass;
        readonly length: number;
        readonly source: string; //fn.toString()
        readonly prototypeMembers: ReadonlyArray<ValueInfo>;
        readonly namespaceMembers: ReadonlyArray<ValueInfo>;
    }
    export interface ArrayInfo extends ValueInfoBase {
        readonly kind: ValueKind.Array;
        readonly inner: ValueInfo;
    }
    //interface FunctionInfo extends ValueInfoBase {
    //    readonly kind: ValueKind.Function;
    //    readonly text: string; //fn.toString()
    //    readonly namespaceMembers: ReadonlyArray<ValueInfo>;
    //}
    //interface ClassInfo extends ValueInfoBase {
    //    readonly kind: ValueKind.Class;
    //    readonly members: ReadonlyArray<ClassElementLike>;
    //    readonly namespaceMembers: ReadonlyArray<ValueInfo>;
    //}
    export interface ObjectInfo extends ValueInfoBase {
        readonly kind: ValueKind.Object;
        readonly members: ReadonlyArray<ValueInfo>;
    }

    //name
    //object and function not included here -- that's FunctionInfo or NamespaceInfo
    //!
    const anyType = (name: string, comment?: string): ValueInfo => ({ kind: ValueKind.Const, name, typeName: "any", comment });

    export function inspectModule({ fileNameToRequire }: InspectValueOptions): ValueInfo {
        //watch out for "default.ts"! change the name!@
        return inspectValue(ts.removeFileExtension(getBaseFileName(fileNameToRequire)), tryRequire(fileNameToRequire));
    }
    export function inspectValue(name: string, value: unknown): ValueInfo {
        return getValueInfo(name, value, getRecurser()); //name is dummy
    }

    type Recurser = <T>(obj: unknown, name: string, cbOk: () => T, cbFail: (isCircularReference: boolean, keyStack: ReadonlyArray<string>) => T) => T;
    function getRecurser(): Recurser {
        const seen = new Set<unknown>();
        const nameStack: string[] = [];
        return (obj, name, cbOk, cbFail) => {
            if (seen.has(obj) || nameStack.length > 4) {
                return cbFail(seen.has(obj), nameStack);
            }

            seen.add(obj);
            nameStack.push(name);
            const res = cbOk();
            nameStack.pop();
            seen.delete(obj);
            return res;
        };
    }

    function getValueInfo(name: string, value: unknown, recurser: Recurser): ValueInfo {
        return recurser(value, name,
            (): ValueInfo => {
                if (typeof value === "function") return getFunctionOrClassInfo(value as AnyFunction, name, recurser);
                if (typeof value === "object") {
                    const x = getBuiltinType(name, value as object, recurser); //name
                    if (x !== undefined) return x;
                    const entries = getEntriesOfObject(value as object);
                    //if (isRoot || entries.some(({ value }) => typeof value === "function")) {
                        return { kind: ValueKind.Object, name, members: flatMap(entries, ({ key, value }) => getValueInfo(key, value, recurser)) };
                    //}
                }
                return { kind: ValueKind.Const, name, typeName: isNullOrUndefined(value) ? "any" : typeof value };
                //return getTypeOfValue(value, recurser);
                //return { kind: ValueKind.Const, name, type: getTypeOfValue(value, recurser), comment: undefined };
            },
            (isCircularReference, keyStack): ValueInfo =>
                anyType(name, ` ${isCircularReference ? "Circular reference" : "Too-deep object hierarchy"} from ${keyStack.join(".")}`));
                //({ kind: ValueKind.Const, name, type: anyType, comment }));
    }

    function getFunctionOrClassInfo(obj: AnyFunction, name: string, recurser: Recurser): FunctionOrClassInfo {
        const prototypeMembers = getPrototypeMembers(obj, recurser);

        const namespaceMembers = flatMap(getEntriesOfObject(obj), ({ key, value }) => {
            const info = getValueInfo(key, value, recurser);
            //if (classStaticMembers && info) {
            //    switch (info.kind) {
            //        case ValueKind.Const: {
            //            const { name, type, comment } = info;
            //            classStaticMembers.push(create.property(SyntaxKind.StaticKeyword, name, type, comment));
            //            return undefined;
            //        }
            //        case ValueKind.FunctionOrClass: {
            //            const { name, parameters, returnType, namespaceMembers: itsNamespaceMembers } = info;
            //            if (!itsNamespaceMembers.length) {
            //                classStaticMembers.push(create.method(SyntaxKind.StaticKeyword, name, parameters, returnType));
            //                return undefined;
            //            }
            //        }
            //    }
            //}
            return info;
        });

        return { kind: ValueKind.FunctionOrClass, name, length: cast(obj.length, isNumber), source: functionToString(obj), namespaceMembers, prototypeMembers };

        //if (classStaticMembers) {
        //    const members = [...classStaticMembers, ...(parameters.length === 0 ? emptyArray : [create.ctr(parameters)]), ...classNonStaticMembers];
        //    return { kind: ValueKind.Class, name, members, namespaceMembers };
        //}
        //else {
        //    return { kind: ValueKind.FunctionOrClass, name, parameters, returnType, namespaceMembers };
        //}
    }

    //!
    function isNumber(x: unknown): x is number {
        return typeof x === "number";
    }

    function functionToString(fn: AnyFunction): string { //inline?
        return cast(Function.prototype.toString.call(fn), isString);
    }

    const builtins: () => ReadonlyMap<AnyConstructor> = memoize(() => {
        const map = createMap<AnyConstructor>();
        for (const { key, value } of getEntriesOfObject(global)) {
            if (typeof value === "function" && typeof value.prototype === "object" && value !== Object) {
                map.set(key, value as AnyConstructor);
            }
        }
        return map;
    });

    function getBuiltinType(name: string, value: object, recurser: Recurser): ValueInfo | undefined {
        if (isArray(value)) {
            return {
                name,
                kind: ValueKind.Array,
                inner: value.length && getValueInfo("element", first(value), recurser) || anyType(name), //todo: "element" will confuse recurser
            }
        }
        return forEachEntry(builtins(), (builtin, builtinName): ValueInfo | undefined => value instanceof builtin ? { kind: ValueKind.Const, name, typeName: builtinName } : undefined);
    }

    function getPrototypeMembers(fn: AnyFunction, recurser: Recurser): ReadonlyArray<ValueInfo> {
        return !fn.prototype ? emptyArray : mapDefined(fn.prototype === undefined ? undefined : getEntriesOfObject(fn.prototype), ({ key, value }) => {
            if (key === "constructor") return undefined;
            return getValueInfo(key, value, recurser);

            //if (key === "constructor") return undefined;
            //if (typeof value !== "function") return undefined;
            //const fnAst = parseClassOrFunctionBody(value as AnyFunction);
            //if (!fnAst) return undefined;
            //const { parameters, returnType } = getParameterListAndReturnType(value as AnyFunction, fnAst);
            //const comment = isNativeFunction(value as AnyFunction) ? " Native method; no parameter or return type inference available" : undefined;
            //return create.method(/*modifier*/ undefined, key, parameters, returnType, comment);
        });
    }

    const ignoredProperties: ReadonlySet<string> = new Set(["arguments", "caller", "constructor", "eval", "super_", "toString"]);
    const reservedFunctionProperties: ReadonlySet<string> = new Set(Object.getOwnPropertyNames(noop));
    interface ObjectEntry { readonly key: string; readonly value: unknown; }
    function getEntriesOfObject(obj: object): ReadonlyArray<ObjectEntry> {
        const entries: ObjectEntry[] = [];
        let chain = obj;
        while (!isNullOrUndefined(chain) && chain !== Object.prototype && chain !== Function.prototype) {
            for (const key of Object.getOwnPropertyNames(chain)) {
                if (!isJsPrivate(key) && !ignoredProperties.has(key) && (typeof obj !== "function" || !reservedFunctionProperties.has(key))) {
                    entries.push({ key, value: Object.getOwnPropertyDescriptor(chain, key)!.value });
                }
            }
            chain = Object.getPrototypeOf(chain);
        }
        return sortAndDeduplicate(entries, (e1, e2) => compareStringsCaseSensitive(e1.key, e2.key));
    }

    function isNullOrUndefined(value: unknown): value is null | undefined {
        return value == null; // tslint:disable-line
    }

    export function isJsPrivate(name: string): boolean {
        return name.startsWith("_");
    }
}
