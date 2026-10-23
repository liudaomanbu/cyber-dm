/** IDs are scoped to a script version; identically named roles in other scripts never share configuration. */
export function bindingKey(scriptId:string,roleId:string):string{return `${scriptId}:${roleId}`;}
