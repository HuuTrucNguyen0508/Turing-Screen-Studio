"""USB discovery and exclusive interface ownership, without real hardware."""
import errno
import os
import struct
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from turzx_studio.integration import assert_usb_available
from turzx_studio.usb_ownership import open_claimed_device


class USBOwnershipTests(unittest.TestCase):
    def test_open_discovery_handle_does_not_block_an_unclaimed_interface(self):
        with patch('turzx_studio.integration.usb_paths', return_value=['/dev/bus/usb/001/004']), \
                patch('os.open', return_value=42) as opened, patch('os.close') as closed, \
                patch('fcntl.ioctl', side_effect=OSError(errno.ENODATA, 'unclaimed')) as query:
            assert_usb_available()
        opened.assert_called_once_with('/dev/bus/usb/001/004', os.O_RDWR | os.O_CLOEXEC)
        closed.assert_called_once_with(42)
        self.assertEqual(query.call_args.args[2][:4], struct.pack('I', 0))

    def test_actual_userspace_claim_and_kernel_driver_are_both_refused(self):
        for driver in (b'usbfs', b'hid-generic'):
            def respond(fd, request, data, mutate):
                data[4:4 + len(driver)] = driver
            with self.subTest(driver=driver), \
                    patch('turzx_studio.integration.usb_paths', return_value=['/dev/screen']), \
                    patch('os.open', return_value=42), patch('os.close') as closed, \
                    patch('fcntl.ioctl', side_effect=respond):
                with self.assertRaisesRegex(RuntimeError, 'interface 0.*claimed'):
                    assert_usb_available()
                closed.assert_called_once_with(42)

    def test_unknown_query_errors_fail_closed_and_close_the_handle(self):
        for error in (errno.EPERM, errno.EIO, errno.ENODEV, errno.ENOTTY):
            with self.subTest(error=error), \
                    patch('turzx_studio.integration.usb_paths', return_value=['/dev/screen']), \
                    patch('os.open', return_value=42), patch('os.close') as closed, \
                    patch('fcntl.ioctl', side_effect=OSError(error, 'failed')):
                with self.assertRaises(OSError):
                    assert_usb_available()
                closed.assert_called_once_with(42)

    def test_no_device_never_opens_usb(self):
        with patch('turzx_studio.integration.usb_paths', return_value=[]), patch('os.open') as opened:
            assert_usb_available()
        opened.assert_not_called()


class ClaimedDeviceTests(unittest.TestCase):
    def setUp(self):
        self.config = SimpleNamespace(bConfigurationValue=1)
        self.device = SimpleNamespace(get_active_configuration=Mock(return_value=self.config),
            _ctx=SimpleNamespace(backend=SimpleNamespace(get_configuration=Mock(return_value=1)), handle=object()),
            set_configuration=Mock(), detach_kernel_driver=Mock(), reset=Mock())
        self.core = SimpleNamespace(find=Mock(return_value=self.device))
        self.util = SimpleNamespace(ENDPOINT_IN=128, ENDPOINT_OUT=0,
            endpoint_direction=lambda endpoint: endpoint & 128,
            find_descriptor=Mock(return_value=[SimpleNamespace(bEndpointAddress=1), SimpleNamespace(bEndpointAddress=129)]),
            claim_interface=Mock(), dispose_resources=Mock())

    def acquire(self):
        return open_claimed_device(self.core, self.util, 0x1cbe, [0x0080])

    def test_claim_is_held_on_the_returned_device_and_configuration_is_checked_after_claim(self):
        order = []
        self.util.claim_interface.side_effect = lambda *args: order.append('claim')
        self.device._ctx.backend.get_configuration.side_effect = lambda *args: order.append('check') or 1
        self.assertEqual(self.acquire(), (self.device, 0x0080))
        self.assertEqual(order, ['claim', 'check'])
        self.util.claim_interface.assert_called_once_with(self.device, 0)
        self.util.dispose_resources.assert_not_called()
        for method in ('set_configuration', 'detach_kernel_driver', 'reset'):
            getattr(self.device, method).assert_not_called()

    def test_busy_claim_disposes_without_querying_or_forcing_configuration(self):
        self.util.claim_interface.side_effect = OSError(errno.EBUSY, 'claimed elsewhere')
        with self.assertRaisesRegex(OSError, 'claimed elsewhere'):
            self.acquire()
        self.util.dispose_resources.assert_called_once_with(self.device)
        self.device._ctx.backend.get_configuration.assert_not_called()
        self.device.set_configuration.assert_not_called()
        self.device.detach_kernel_driver.assert_not_called()

    def test_configuration_race_releases_the_acquired_claim(self):
        self.device._ctx.backend.get_configuration.return_value = 2
        with self.assertRaisesRegex(RuntimeError, 'configuration changed'):
            self.acquire()
        self.util.claim_interface.assert_called_once()
        self.util.dispose_resources.assert_called_once_with(self.device)

    def test_missing_configuration_or_endpoints_fail_before_claim_and_dispose(self):
        for fault in ('configuration', 'interface', 'endpoints'):
            with self.subTest(fault=fault):
                self.setUp()
                if fault == 'configuration':
                    self.device.get_active_configuration.side_effect = OSError('unconfigured')
                else:
                    self.util.find_descriptor.return_value = None if fault == 'interface' else [SimpleNamespace(bEndpointAddress=1)]
                with self.assertRaises((RuntimeError, OSError)):
                    self.acquire()
                self.util.claim_interface.assert_not_called()
                self.util.dispose_resources.assert_called_once_with(self.device)
                self.device.set_configuration.assert_not_called()

    def test_no_device_returns_not_found_without_claim_or_disposal(self):
        self.core.find.return_value = None
        with self.assertRaisesRegex(ValueError, 'USB device not found'):
            self.acquire()
        self.util.claim_interface.assert_not_called()
        self.util.dispose_resources.assert_not_called()


if __name__ == '__main__':
    unittest.main()
