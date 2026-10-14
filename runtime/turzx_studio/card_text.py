"""Shared card labels and document-pixel padding."""

import math


def card_padding(width):
    return min(29, width // 6)


SENSOR_SHORT_LABELS = {
    'cpu': 'CPU', 'gpu': 'GPU', 'memory': 'Memory', 'disk': 'Disk', 'network-down': 'Download',
    'network-up': 'Upload', 'cpu-temperature': 'CPU temp', 'gpu-temperature': 'GPU temp',
}

def shorten_text(text, capacity):
    return text[:max(0, capacity - 1)] + '…' if len(text) > capacity else text


def card_kicker(label, width):
    return shorten_text(label, max(1, math.floor((width - 2 * card_padding(width)) / 8)))
