'use strict';

const { createApi } = require('./service');
const { createRepository } = require('./repository');

let api;
exports.main = async (event) => {
  const cloud = require('wx-server-sdk');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, throwOnNotFound: false });
  if (!api) {
    api = createApi({
      repo: createRepository(cloud.database({ throwOnNotFound: false })),
      templateId: process.env.TEMPLATE_ID || ''
    });
  }
  // Identity is provided by the platform, never by event/payload.
  return api(event, cloud.getWXContext());
};
