  } else {
    // Si existe pero está vacía, escribir headers
    const firstRow = await getSheetValues(`${sheetName}!A1:Z1`);
    if (!firstRow.length || firstRow[0].join("").trim() === "") {
      await setSheetValues(`${sheetName}!A1`, [headers]);
    }
  }
}
