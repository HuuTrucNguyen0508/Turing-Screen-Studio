"""Claim the configured screen without resetting it or evicting other drivers."""


def open_claimed_device(core, util, vendor, products):
    for product in products:
        device = core.find(idVendor=vendor, idProduct=product)
        if device is None:
            continue
        try:
            config = device.get_active_configuration()
            interface = util.find_descriptor(config, bInterfaceNumber=0)
            if interface is None:
                raise RuntimeError('TURZX USB interface 0 not found in the active configuration')
            endpoints = {util.endpoint_direction(endpoint.bEndpointAddress) for endpoint in interface}
            if not {util.ENDPOINT_IN, util.ENDPOINT_OUT}.issubset(endpoints):
                raise RuntimeError('TURZX USB interface 0 needs input and output endpoints')
            # Atomic kernel claim, kept on this exact transport handle. No detach.
            util.claim_interface(device, 0)
            # PyUSB caches get_active_configuration(). Query its backend again
            # after claiming to reject a configuration change during acquisition.
            manager = device._ctx
            if manager.backend.get_configuration(manager.handle) != config.bConfigurationValue:
                raise RuntimeError('TURZX USB configuration changed while claiming interface 0')
            return device, product
        except Exception:
            util.dispose_resources(device)
            raise
    raise ValueError('USB device not found')
