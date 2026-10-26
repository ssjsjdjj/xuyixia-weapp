Page({ data: { cloud: false }, onShow() { this.setData({ cloud: getApp().config.storageMode === 'cloud' }); } });
