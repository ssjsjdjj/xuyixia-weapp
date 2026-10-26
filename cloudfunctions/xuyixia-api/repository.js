'use strict';

const COLLECTIONS = {
  tasks: 'xyx_tasks', records: 'xyx_records', settings: 'xyx_settings',
  subscriptions: 'xyx_subscriptions', deliveries: 'xyx_deliveries', mutations: 'xyx_mutations', joints: 'xyx_joints', invitations: 'xyx_invitations', jointRecords: 'xyx_joint_records'
};

function createRepository(db) {
  const scoped = (handle) => ({
    async get(collection, id) {
      const result = await handle.collection(COLLECTIONS[collection]).doc(id).get();
      return result.data || null;
    },
    async put(collection, id, document) {
      const clean = { ...document };
      delete clean._id;
      await handle.collection(COLLECTIONS[collection]).doc(id).set({ data: clean });
    },
    async remove(collection, id) {
      await handle.collection(COLLECTIONS[collection]).doc(id).remove();
    }
  });
  return {
    ...scoped(db),
    async query(collection, filter = {}) {
      const output = [];
      let offset = 0;
      while (true) {
        const result = await db.collection(COLLECTIONS[collection]).where(filter)
          .orderBy('_id', 'asc').skip(offset).limit(100).get();
        output.push(...result.data);
        if (result.data.length < 100) return output;
        offset += result.data.length;
      }
    },
    async atomic(callback) {
      // Pinned wx-server-sdk 4.0.2 / @cloudbase/database 1.4.3 return the callback
      // value directly. Do not unwrap a 'result' property in application data.
      return db.runTransaction(tx => callback(scoped(tx)));
    }
  };
}

module.exports = { COLLECTIONS, createRepository };
