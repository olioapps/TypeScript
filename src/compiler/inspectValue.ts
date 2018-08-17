namespace ts {
    export interface InspectValueOptions {
        fileNameToRequire: string;
    }
    export type ValueInfo = number;
    export function inspectValue(_options: InspectValueOptions): ValueInfo {
        throw new Error("TODO");
    }
}
