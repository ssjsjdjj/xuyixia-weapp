'use strict';

// Serializes transactions and rolls them back on errors; no SDK, network or credentials.
function memoryRepository() {
  let collections = new Map();
  let queue = Promise.resolve();
  const copy = value => value === undefined ? null : structuredClone(value);
  function access(state) {
    const collection = name => {
      if (!state.has(name)) state.set(name, new Map());
      return state.get(name);
    };
    return {
      async get(name, id) { return copy(collection(name).get(id)); },
      async put(name, id, document) { collection(name).set(id, { ...copy(document), _id: id }); },
      async remove(name, id) { collection(name).delete(id); }
    };
  }
  return {
    async get(...args) { return access(collections).get(...args); },
    async put(...args) { return access(collections).put(...args); },
    async remove(...args) { return access(collections).remove(...args); },
    async query(name, filter = {}) {
      return [...(collections.get(name) || new Map()).values()]
        .filter(document => Object.entries(filter).every(([field, value]) => document[field] === value)).map(copy);
    },
    async atomic(callback) {
      let release;
      const previous = queue;
      queue = new Promise(resolve => { release = resolve; });
      await previous;
      const snapshot = structuredClone(collections);
      try {
        const result = await callback(access(snapshot));
        collections = snapshot;
        return result;
      } finally { release(); }
    }
  };
}

module.exports = { memoryRepository };
