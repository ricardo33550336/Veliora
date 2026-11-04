package org.veliora.television

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener

/**
 * 起播预热的内存命中层：包在真正的网络 DataSource 外面。
 * 命中 [PlaybackPrefetch] 时完全不走网络；未命中则原样透传给上游（行为与不加这一层一致）。
 *
 * 只接管「整份读取」的请求（position == 0 且没限长）：播放列表才是这样读的，分片请求
 * 带 Range 或整段下载，一律透传，避免把缓存语义搞乱。
 */
@UnstableApi
class PrefetchDataSource(private val upstream: DataSource) : DataSource {

    class Factory(private val upstreamFactory: DataSource.Factory) : DataSource.Factory {
        override fun createDataSource(): DataSource =
            PrefetchDataSource(upstreamFactory.createDataSource())
    }

    private var cachedBytes: ByteArray? = null
    private var cachedUri: Uri? = null
    private var readPos = 0

    override fun addTransferListener(transferListener: TransferListener) {
        upstream.addTransferListener(transferListener)
    }

    override fun open(dataSpec: DataSpec): Long {
        reset()
        val wholeRead = dataSpec.position == 0L && dataSpec.length == C.LENGTH_UNSET.toLong()
        if (wholeRead) {
            val hit = PlaybackPrefetch.take(dataSpec.uri.toString())
            if (hit != null) {
                cachedBytes = hit.bytes
                // 用重定向后的最终地址当基地址：相对分片路径才对得上（与直接走网络时一致）
                cachedUri = Uri.parse(hit.baseUrl)
                return hit.bytes.size.toLong()
            }
        }
        return upstream.open(dataSpec)
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        val data = cachedBytes ?: return upstream.read(buffer, offset, length)
        if (readPos >= data.size) return C.RESULT_END_OF_INPUT
        val n = minOf(length, data.size - readPos)
        System.arraycopy(data, readPos, buffer, offset, n)
        readPos += n
        return n
    }

    override fun getUri(): Uri? = cachedUri ?: upstream.uri

    override fun close() {
        reset()
        upstream.close()
    }

    private fun reset() {
        cachedBytes = null
        cachedUri = null
        readPos = 0
    }
}
