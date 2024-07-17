## debug-log

This was created to make console debugging easier when you often need to compare JavaScript object values.

### API
#### `debugLog`

The count is incremented automatically with each call.

![debugLog](https://github.com/user-attachments/assets/a0a2b545-be99-4db2-98d9-cc4535563d8a)

```typescript
debugLog();
console.log("test");

debugLog("with title debugLog");
console.log("test2");
```

#### `jsonLog`

Output JSON with the debug log.
If you just want to print JSON purely, use `jsonPrint`.

![image](https://github.com/user-attachments/assets/e5bb7c93-baec-419c-8472-19b014d72ce0)

```typescript
jsonLog({ key1: true, key2: 1, key3: null, key4: "string" });
jsonLog("with title jsonLog", { others: undefined });
```

#### `jsonExpect`

Compare the JSON and show the differences.

![image](https://github.com/user-attachments/assets/941dc0a8-aa9a-4196-877d-417a912e81d1)

```typescript
jsonExpect({ a: 1 }, { a: 2 });
jsonExpect("with title jsonExpect", { b: 1 }, { c: "1" });
```
